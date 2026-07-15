import type { Node, Edge } from '@xyflow/svelte';
import type {
	Workflow,
	WorkflowNode,
	WorkflowEdge,
	WorkflowStep,
	WorkflowConditionNodeData,
	WorkflowLoopNodeData,
	WorkflowNodeType,
	AgentTriggerKind
} from '@repo/types';

/**
 * Frontend-only graph helpers for the visual workflow builder.
 *
 * This is a parallel copy of the pure conversion logic in `@repo/utils/workflow/graph`
 * — duplicated deliberately because `@repo/utils` resolves its runtime entry to `./dist`
 * which pulls `node:fs` via the barrel and would break Vite/SSR. Keep the two in sync.
 *
 * It also provides the mapping between our persisted domain graph (`WorkflowNode`/
 * `WorkflowEdge`) and Svelte Flow's render model (`Node`/`Edge`).
 */

export const TRIGGER_NODE_ID = 'trigger';

/** DataTransfer MIME type used when dragging a palette item onto the canvas. */
export const DRAG_MIME = 'application/x-workflow-node';

// Deterministic horizontal layout constants for generated graphs (left → right).
const START_X = 60;
const COL_GAP = 300;
const NODE_Y = 80;

/** A fresh, empty agent step. */
export function defaultStep(): WorkflowStep {
	return {
		id: crypto.randomUUID(),
		name: '',
		instruction: '',
		allowedTools: [],
		allTools: false,
		allowedCredentialIds: [],
		allCredentials: false,
		errorHandling: { action: 'stop' }
	};
}

/** A fresh condition node config (Smart mode by default). */
export function defaultConditionData(): WorkflowConditionNodeData {
	return {
		name: 'Condition',
		evalMode: 'smart',
		prompt: '',
		filter: { combinator: 'and', conditions: [] },
		errorHandling: { action: 'stop' }
	};
}

/** A fresh loop node config (For each by default; while-condition is Smart). */
export function defaultLoopData(): WorkflowLoopNodeData {
	return {
		name: 'Loop',
		mode: 'forEach',
		items: '',
		evalMode: 'smart',
		prompt: '',
		condition: { combinator: 'and', conditions: [] },
		maxIterations: 10
	};
}

/** Build a fresh Svelte Flow node of the given type at a position (null for trigger). */
export function newFlowNode(
	type: WorkflowNodeType,
	position: { x: number; y: number }
): Node | null {
	if (type === 'agent') {
		const step = defaultStep();
		return { id: step.id, type, position, data: { step }, deletable: true };
	}
	if (type === 'condition') {
		return {
			id: crypto.randomUUID(),
			type,
			position,
			data: { condition: defaultConditionData() },
			deletable: true
		};
	}
	if (type === 'loop') {
		return {
			id: crypto.randomUUID(),
			type,
			position,
			data: { loop: defaultLoopData() },
			deletable: true
		};
	}
	return null;
}

/** Convert a legacy linear step list into a graph: trigger → step0 → step1 → … */
export function stepsToGraph(steps: WorkflowStep[]): {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
} {
	const nodes: WorkflowNode[] = [
		{
			id: TRIGGER_NODE_ID,
			type: 'trigger',
			position: { x: START_X, y: NODE_Y },
			data: { label: 'Trigger' }
		}
	];
	const edges: WorkflowEdge[] = [];

	let prevId = TRIGGER_NODE_ID;
	steps.forEach((step, i) => {
		nodes.push({
			id: step.id,
			type: 'agent',
			position: { x: START_X + (i + 1) * COL_GAP, y: NODE_Y },
			data: step
		});
		edges.push({ id: `e-${prevId}-${step.id}`, source: prevId, target: step.id });
		prevId = step.id;
	});

	return { nodes, edges };
}

/**
 * The initial domain graph to seed the builder with:
 *  - edit mode: the workflow's saved graph (or one synthesized from legacy steps)
 *  - create mode: a trigger + one empty step
 */
export function initialDomainGraph(workflow?: Pick<Workflow, 'nodes' | 'edges' | 'steps'> | null): {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
} {
	if (workflow?.nodes && workflow.nodes.length > 0) {
		return { nodes: workflow.nodes, edges: workflow.edges ?? [] };
	}
	const steps = workflow?.steps && workflow.steps.length > 0 ? workflow.steps : [defaultStep()];
	return stepsToGraph(steps);
}

// ─── Domain ⇄ Svelte Flow render model ─────────────────────────────────────────

/** Render data attached to each Svelte Flow node, by node type. */
export type AgentNodeRender = { step: WorkflowStep };
export type TriggerNodeRender = { kind: AgentTriggerKind; label: string };
export type ConditionNodeRender = { condition: WorkflowConditionNodeData };
export type LoopNodeRender = { loop: WorkflowLoopNodeData };

/**
 * Decide an edge's label from its handles. Branch/loop edges get a visible label
 * (true/false/loop/done, or the loop back-edge); all edges render as smoothstep.
 * Built-in Svelte Flow edges render the `label` natively, so no custom edge type
 * is needed.
 */
export function edgeVisual(
	sourceHandle?: string | null,
	targetHandle?: string | null,
	existingLabel?: string
): { type: string; label: string | undefined } {
	const sh = sourceHandle ?? '';
	// The loop body's first node connects out from the 'loop' handle ("loop start");
	// its last node connects back into 'loopBack' ("loop end"). Keep these edge labels
	// in sync with the handle labels on LoopNode so connections read clearly.
	if (sh === 'loop') {
		return { type: 'smoothstep', label: existingLabel ?? 'loop start' };
	}
	if (sh === 'true' || sh === 'false' || sh === 'done') {
		return { type: 'smoothstep', label: existingLabel ?? sh };
	}
	if (targetHandle === 'loopBack') {
		return { type: 'smoothstep', label: existingLabel ?? 'loop end' };
	}
	return { type: 'smoothstep', label: existingLabel };
}

/** Map persisted domain nodes/edges into Svelte Flow's render model. */
export function domainToFlow(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
	triggerKind: AgentTriggerKind
): { nodes: Node[]; edges: Edge[] } {
	const flowNodes: Node[] = nodes.map((n) => {
		const position = { x: n.position.x, y: n.position.y };
		if (n.type === 'agent') {
			return { id: n.id, type: 'agent', position, data: { step: n.data }, deletable: true };
		}
		if (n.type === 'condition') {
			return {
				id: n.id,
				type: 'condition',
				position,
				data: { condition: n.data },
				deletable: true
			};
		}
		if (n.type === 'loop') {
			return { id: n.id, type: 'loop', position, data: { loop: n.data }, deletable: true };
		}
		// trigger — not deletable; carries the current trigger kind for its badge
		return {
			id: n.id,
			type: 'trigger',
			position,
			data: { kind: triggerKind, label: n.data.label ?? 'Trigger' },
			deletable: false
		};
	});

	const flowEdges: Edge[] = edges.map((e) => {
		const visual = edgeVisual(e.sourceHandle, e.targetHandle, e.label);
		return {
			id: e.id,
			source: e.source,
			target: e.target,
			sourceHandle: e.sourceHandle,
			targetHandle: e.targetHandle,
			label: visual.label,
			type: visual.type,
			deletable: true
		};
	});

	return { nodes: flowNodes, edges: flowEdges };
}

/** Map Svelte Flow's render model back into persisted domain nodes/edges. */
export function flowToDomain(
	nodes: Node[],
	edges: Edge[]
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
	const domainNodes: WorkflowNode[] = nodes.map((n) => {
		const position = { x: n.position.x, y: n.position.y };
		if (n.type === 'agent') {
			return { id: n.id, type: 'agent', position, data: (n.data as AgentNodeRender).step };
		}
		if (n.type === 'condition') {
			return {
				id: n.id,
				type: 'condition',
				position,
				data: (n.data as ConditionNodeRender).condition
			};
		}
		if (n.type === 'loop') {
			return { id: n.id, type: 'loop', position, data: (n.data as LoopNodeRender).loop };
		}
		const label = (n.data as Partial<TriggerNodeRender>)?.label;
		return { id: n.id, type: 'trigger', position, data: { label: label ?? 'Trigger' } };
	});

	const domainEdges: WorkflowEdge[] = edges.map((e) => ({
		id: e.id,
		source: e.source,
		target: e.target,
		sourceHandle: e.sourceHandle ?? undefined,
		targetHandle: e.targetHandle ?? undefined,
		label: typeof e.label === 'string' ? e.label : undefined
	}));

	return { nodes: domainNodes, edges: domainEdges };
}
