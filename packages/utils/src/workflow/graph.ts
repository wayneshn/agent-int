import { randomUUID } from 'crypto';
import type {
	Workflow,
	WorkflowNode,
	WorkflowEdge,
	WorkflowStep,
	WorkflowAgentNode,
	WorkflowTriggerNode,
	WorkflowSpec,
} from '@repo/types';

/**
 * Pure (no node:fs) conversions between the legacy linear `steps[]` model and the
 * authoritative node/edge graph model. Shared by the backend service, the workflow
 * runner, and (a parallel copy of `stepsToGraph`/`ensureGraph`) the frontend.
 */

/** The fixed id of the synthetic trigger node in generated graphs. */
export const TRIGGER_NODE_ID = 'trigger';

// Deterministic horizontal layout constants for generated graphs (left → right).
const START_X = 60;
const COL_GAP = 300;
const NODE_Y = 80;

/**
 * Convert a legacy linear step list into a graph: trigger → step0 → step1 → …
 * Deterministic positions so re-running produces an identical layout.
 */
export function stepsToGraph(steps: WorkflowStep[]): {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
} {
	const triggerNode: WorkflowTriggerNode = {
		id: TRIGGER_NODE_ID,
		type: 'trigger',
		position: { x: START_X, y: NODE_Y },
		data: { label: 'Trigger' },
	};
	const nodes: WorkflowNode[] = [triggerNode];
	const edges: WorkflowEdge[] = [];

	let prevId = TRIGGER_NODE_ID;
	steps.forEach((step, i) => {
		const node: WorkflowAgentNode = {
			id: step.id,
			type: 'agent',
			position: { x: START_X + (i + 1) * COL_GAP, y: NODE_Y },
			data: step,
		};
		nodes.push(node);
		edges.push({ id: `e-${prevId}-${step.id}`, source: prevId, target: step.id });
		prevId = step.id;
	});

	return { nodes, edges };
}

/**
 * Project a graph back to a linear step list (topological order of agent nodes).
 * Keeps the legacy `steps` column populated for backward-compatible reads. For
 * branchy/looping graphs this is a best-effort main-path projection — the
 * execution engine uses the graph itself, not this output.
 */
export function graphToSteps(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowStep[] {
	const agentNodes = new Map<string, WorkflowAgentNode>();
	for (const n of nodes) {
		if (n.type === 'agent') agentNodes.set(n.id, n);
	}
	if (agentNodes.size === 0) return [];

	const ordered = topoOrder(nodes, edges).filter((id) => agentNodes.has(id));
	// Append any agent nodes the traversal didn't reach (disconnected) so no step
	// config is silently dropped from the legacy projection.
	const seen = new Set(ordered);
	for (const n of nodes) {
		if (n.type === 'agent' && !seen.has(n.id)) ordered.push(n.id);
	}
	return ordered.map((id) => agentNodes.get(id)!.data);
}

/**
 * Lazy fallback: return the workflow's graph, synthesizing one from `steps` when
 * the graph columns are empty (rows created before the graph migration/backfill).
 * Guarantees every read path has a usable graph.
 */
export function ensureGraph(wf: Pick<Workflow, 'nodes' | 'edges' | 'steps'>): {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
} {
	if (wf.nodes && wf.nodes.length > 0) {
		return { nodes: wf.nodes, edges: wf.edges ?? [] };
	}
	return stepsToGraph(wf.steps ?? []);
}

// ─── High-level spec → graph (agent create_workflow authoring) ─────────────────

/** Rewrite {{steps.<key>.output…}} references to the generated node UUIDs. */
function rewriteRefs(text: string | undefined, idByKey: Map<string, string>): string | undefined {
	if (!text) return text;
	return text.replace(/\{\{steps\.([A-Za-z0-9_-]+)\.output/g, (whole, key: string) => {
		const id = idByKey.get(key);
		return id ? `{{steps.${id}.output` : whole;
	});
}

/** Simple layered layout, left-to-right: depth from the trigger (ignoring loop back-edges). */
function layeredLayout(nodes: WorkflowNode[], edges: WorkflowEdge[]): void {
	const COL = 300; // horizontal gap between depth levels
	const ROW = 170; // vertical gap between siblings at the same depth
	const X0 = 60;
	const Y0 = 60;
	const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
	for (const e of edges) {
		if (e.targetHandle === 'loopBack') continue;
		adj.get(e.source)?.push(e.target);
	}
	const depth = new Map<string, number>([[TRIGGER_NODE_ID, 0]]);
	const queue = [TRIGGER_NODE_ID];
	while (queue.length > 0) {
		const id = queue.shift()!;
		const d = depth.get(id)!;
		for (const t of adj.get(id) ?? []) {
			if (!depth.has(t)) {
				depth.set(t, d + 1);
				queue.push(t);
			}
		}
	}
	const perDepth = new Map<number, number>();
	for (const n of nodes) {
		const d = depth.get(n.id) ?? 0;
		const row = perDepth.get(d) ?? 0;
		perDepth.set(d, row + 1);
		n.position = { x: X0 + d * COL, y: Y0 + row * ROW };
	}
}

/**
 * Convert a high-level WorkflowSpec (agent-authored) into a real node/edge graph:
 * generates node UUIDs, the trigger node + entry edge, handle-correct edges
 * (out / true / false / loop / done + the loop back-edge), node positions, and
 * rewrites {{steps.<key>.output}} references to the generated ids. Throws on
 * structural errors (no nodes, duplicate keys, unknown key, missing entry).
 */
export function specToGraph(spec: WorkflowSpec): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
	if (!spec.nodes || spec.nodes.length === 0) {
		throw new Error('Workflow must have at least one node');
	}
	const keys = spec.nodes.map((n) => n.key);
	if (new Set(keys).size !== keys.length) {
		throw new Error('Workflow node keys must be unique');
	}
	if (!keys.includes(spec.entry)) {
		throw new Error(`entry "${spec.entry}" is not a defined node key`);
	}

	const idByKey = new Map<string, string>();
	for (const n of spec.nodes) idByKey.set(n.key, randomUUID());

	// Body nodes are sequenced by their loop, so ignore any `next` they declare.
	const bodyKeys = new Set<string>();
	for (const n of spec.nodes) {
		if (n.type === 'loop') for (const k of n.body ?? []) bodyKeys.add(k);
	}

	const refId = (key: string | undefined, label: string): string | undefined => {
		if (!key) return undefined;
		const id = idByKey.get(key);
		if (!id) throw new Error(`${label} references unknown node key "${key}"`);
		return id;
	};

	const nodes: WorkflowNode[] = [
		{ id: TRIGGER_NODE_ID, type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger' } },
	];
	const edges: WorkflowEdge[] = [];
	const link = (source: string, target: string, sourceHandle: string, targetHandle: string) => {
		edges.push({
			id: `e-${source}-${sourceHandle}-${target}`,
			source,
			target,
			sourceHandle,
			targetHandle,
		});
	};

	link(TRIGGER_NODE_ID, idByKey.get(spec.entry)!, 'out', 'in');

	for (const n of spec.nodes) {
		const id = idByKey.get(n.key)!;
		if (n.type === 'condition') {
			nodes.push({
				id,
				type: 'condition',
				position: { x: 0, y: 0 },
				data: {
					name: n.name,
					evalMode: 'smart',
					prompt: rewriteRefs(n.prompt, idByKey) ?? '',
					filter: { combinator: 'and', conditions: [] },
					// Conditions are retry-then-stop only — any non-'retry' action maps to 'stop'.
					errorHandling:
						n.errorHandlingAction === 'retry'
							? { action: 'retry', maxRetries: n.maxRetries ?? 1 }
							: { action: 'stop' },
				},
			});
			const t = refId(n.ifTrue, `Condition "${n.name}" (true)`);
			const f = refId(n.ifFalse, `Condition "${n.name}" (false)`);
			if (t) link(id, t, 'true', 'in');
			if (f) link(id, f, 'false', 'in');
		} else if (n.type === 'loop') {
			nodes.push({
				id,
				type: 'loop',
				position: { x: 0, y: 0 },
				data: {
					name: n.name,
					mode: n.loopMode ?? 'forEach',
					items: rewriteRefs(n.items, idByKey),
					evalMode: 'smart',
					prompt: rewriteRefs(n.prompt, idByKey),
					condition: { combinator: 'and', conditions: [] },
					maxIterations: n.maxIterations ?? 10,
				},
			});
			const body = (n.body ?? []).map((k) => refId(k, `Loop "${n.name}" body`)!);
			if (body.length > 0) {
				link(id, body[0], 'loop', 'in');
				for (let i = 0; i < body.length - 1; i++) link(body[i], body[i + 1], 'out', 'in');
				link(body[body.length - 1], id, 'out', 'loopBack');
			}
			const done = refId(n.next, `Loop "${n.name}" (done)`);
			if (done) link(id, done, 'done', 'in');
		} else {
			nodes.push({
				id,
				type: 'agent',
				position: { x: 0, y: 0 },
				data: {
					id,
					name: n.name,
					instruction: rewriteRefs(n.instruction, idByKey) ?? '',
					allowedTools: n.allowedTools ?? [],
					allTools: n.allTools ?? false,
					allowedCredentialIds: n.allowedCredentialIds ?? [],
					allCredentials: n.allCredentials ?? false,
					errorHandling: {
						action: n.errorHandlingAction ?? 'stop',
						...(n.errorHandlingAction === 'retry' ? { maxRetries: n.maxRetries ?? 1 } : {}),
					},
				},
			});
			const next = bodyKeys.has(n.key) ? undefined : refId(n.next, `Step "${n.name}"`);
			if (next) link(id, next, 'out', 'in');
		}
	}

	layeredLayout(nodes, edges);
	return { nodes, edges };
}

/**
 * Detect a directed cycle in the graph. When `ignoreLoopBack` is true, edges that
 * close a loop (targetHandle === 'loopBack') are excluded — so intentional loop
 * cycles are allowed while accidental cycles are still flagged.
 */
export function hasCycle(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
	ignoreLoopBack = false,
): boolean {
	const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
	for (const e of edges) {
		if (ignoreLoopBack && isLoopBackEdge(e)) continue;
		if (adj.has(e.source)) adj.get(e.source)!.push(e.target);
	}

	const visited = new Set<string>();
	const inStack = new Set<string>();

	const dfs = (id: string): boolean => {
		visited.add(id);
		inStack.add(id);
		for (const next of adj.get(id) ?? []) {
			if (inStack.has(next)) return true;
			if (!visited.has(next) && dfs(next)) return true;
		}
		inStack.delete(id);
		return false;
	};

	for (const n of nodes) {
		if (!visited.has(n.id) && dfs(n.id)) return true;
	}
	return false;
}

/** A loop's back-edge: the body's last node feeding back into the loop node. */
export function isLoopBackEdge(e: WorkflowEdge): boolean {
	return e.targetHandle === 'loopBack';
}

/**
 * Kahn's algorithm, ignoring loop back-edges so loop cycles don't deadlock the
 * sort. Stable: zero-indegree nodes are processed in declaration order; any nodes
 * left in a residual cycle are appended in declaration order.
 */
function topoOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
	const ids = nodes.map((n) => n.id);
	const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
	const adj = new Map<string, string[]>(ids.map((id) => [id, []]));

	for (const e of edges) {
		if (isLoopBackEdge(e)) continue;
		if (!indegree.has(e.target) || !adj.has(e.source)) continue;
		adj.get(e.source)!.push(e.target);
		indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
	}

	const queue: string[] = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
	const result: string[] = [];
	const visited = new Set<string>();

	while (queue.length > 0) {
		const id = queue.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);
		result.push(id);
		for (const next of adj.get(id) ?? []) {
			indegree.set(next, (indegree.get(next) ?? 1) - 1);
			if ((indegree.get(next) ?? 0) === 0 && !visited.has(next)) queue.push(next);
		}
	}

	for (const id of ids) {
		if (!visited.has(id)) result.push(id);
	}
	return result;
}
