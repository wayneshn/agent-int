import { describe, it, expect } from 'vitest';
import {
	stepsToGraph,
	graphToSteps,
	ensureGraph,
	specToGraph,
	hasCycle,
	isLoopBackEdge,
	TRIGGER_NODE_ID,
} from './graph.js';
import type { WorkflowNode, WorkflowEdge, WorkflowStep, WorkflowSpec } from '@repo/types';

let n = 0;
function step(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
	n += 1;
	return {
		id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
		name: `Step ${n}`,
		instruction: 'do it',
		allowedTools: [],
		allowedCredentialIds: [],
		errorHandling: { action: 'stop' },
		...overrides,
	};
}

describe('stepsToGraph', () => {
	it('creates trigger → step chain with deterministic layout', () => {
		const steps = [step(), step()];
		const { nodes, edges } = stepsToGraph(steps);

		expect(nodes).toHaveLength(3);
		expect(nodes[0]).toMatchObject({ id: TRIGGER_NODE_ID, type: 'trigger' });
		expect(nodes[1]).toMatchObject({ id: steps[0].id, type: 'agent' });
		expect(nodes[2]).toMatchObject({ id: steps[1].id, type: 'agent' });

		expect(edges).toHaveLength(2);
		expect(edges[0]).toMatchObject({ source: TRIGGER_NODE_ID, target: steps[0].id });
		expect(edges[1]).toMatchObject({ source: steps[0].id, target: steps[1].id });

		// Deterministic: same input ⇒ identical output
		expect(stepsToGraph(steps)).toEqual({ nodes, edges });
	});

	it('empty steps ⇒ trigger only', () => {
		const { nodes, edges } = stepsToGraph([]);
		expect(nodes).toHaveLength(1);
		expect(edges).toHaveLength(0);
	});
});

describe('graphToSteps', () => {
	it('round-trips a linear chain in topological order', () => {
		const steps = [step(), step(), step()];
		const { nodes, edges } = stepsToGraph(steps);
		const projected = graphToSteps(nodes, edges);
		expect(projected.map((s) => s.id)).toEqual(steps.map((s) => s.id));
	});

	it('appends disconnected agent nodes instead of dropping them', () => {
		const steps = [step(), step()];
		const { nodes, edges } = stepsToGraph([steps[0]]);
		nodes.push({ id: steps[1].id, type: 'agent', position: { x: 0, y: 0 }, data: steps[1] });
		const projected = graphToSteps(nodes, edges);
		// Order is Kahn's-queue dependent for disconnected nodes; what matters is
		// that no step config is silently dropped from the legacy projection.
		expect(projected).toHaveLength(2);
		expect(projected.map((s) => s.id).sort()).toEqual([steps[0].id, steps[1].id].sort());
	});

	it('ignores loop back-edges when ordering', () => {
		const steps = [step(), step()];
		const nodes: WorkflowNode[] = [
			{ id: TRIGGER_NODE_ID, type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'T' } },
			{ id: 'loop-1', type: 'loop', position: { x: 0, y: 0 }, data: { name: 'L', mode: 'forEach', maxIterations: 3 } },
			{ id: steps[0].id, type: 'agent', position: { x: 0, y: 0 }, data: steps[0] },
		];
		const edges: WorkflowEdge[] = [
			{ id: 'e1', source: TRIGGER_NODE_ID, target: 'loop-1' },
			{ id: 'e2', source: 'loop-1', target: steps[0].id, sourceHandle: 'loop' },
			{ id: 'e3', source: steps[0].id, target: 'loop-1', targetHandle: 'loopBack' },
		];
		const projected = graphToSteps(nodes, edges);
		expect(projected.map((s) => s.id)).toEqual([steps[0].id]);
	});
});

describe('ensureGraph', () => {
	it('returns existing graph when nodes are present', () => {
		const nodes: WorkflowNode[] = [
			{ id: TRIGGER_NODE_ID, type: 'trigger', position: { x: 0, y: 0 }, data: {} },
		];
		expect(ensureGraph({ nodes, edges: [], steps: [] }).nodes).toBe(nodes);
	});

	it('synthesizes a graph from steps when nodes are empty', () => {
		const steps = [step()];
		const { nodes } = ensureGraph({ nodes: [], edges: [], steps });
		expect(nodes).toHaveLength(2);
	});
});

describe('hasCycle', () => {
	const baseNodes: WorkflowNode[] = [
		{ id: 'a', type: 'condition', position: { x: 0, y: 0 }, data: { name: 'a' } },
		{ id: 'b', type: 'condition', position: { x: 0, y: 0 }, data: { name: 'b' } },
		{ id: 'c', type: 'condition', position: { x: 0, y: 0 }, data: { name: 'c' } },
	];

	it('detects a simple cycle', () => {
		const edges: WorkflowEdge[] = [
			{ id: 'e1', source: 'a', target: 'b' },
			{ id: 'e2', source: 'b', target: 'c' },
			{ id: 'e3', source: 'c', target: 'a' },
		];
		expect(hasCycle(baseNodes, edges)).toBe(true);
	});

	it('acyclic graph ⇒ false', () => {
		const edges: WorkflowEdge[] = [
			{ id: 'e1', source: 'a', target: 'b' },
			{ id: 'e2', source: 'b', target: 'c' },
		];
		expect(hasCycle(baseNodes, edges)).toBe(false);
	});

	it('loop back-edges are ignored when ignoreLoopBack is true', () => {
		const edges: WorkflowEdge[] = [
			{ id: 'e1', source: 'a', target: 'b' },
			{ id: 'e2', source: 'b', target: 'a', targetHandle: 'loopBack' },
		];
		expect(hasCycle(baseNodes, edges, false)).toBe(true);
		expect(hasCycle(baseNodes, edges, true)).toBe(false);
	});

	it('detects self-loops', () => {
		const edges: WorkflowEdge[] = [{ id: 'e1', source: 'a', target: 'a' }];
		expect(hasCycle(baseNodes, edges)).toBe(true);
	});
});

describe('isLoopBackEdge', () => {
	it('identifies by targetHandle', () => {
		expect(isLoopBackEdge({ id: 'e', source: 'a', target: 'b', targetHandle: 'loopBack' })).toBe(true);
		expect(isLoopBackEdge({ id: 'e', source: 'a', target: 'b' })).toBe(false);
	});
});

describe('specToGraph', () => {
	function spec(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
		return {
			entry: 'first',
			nodes: [
				{ key: 'first', type: 'agent', name: 'First', instruction: 'do first', next: 'second' },
				{ key: 'second', type: 'agent', name: 'Second', instruction: 'do second' },
			],
			...overrides,
		} as WorkflowSpec;
	}

	it('builds a valid chain with trigger entry edge', () => {
		const { nodes, edges } = specToGraph(spec());
		const triggerEdge = edges.find((e) => e.source === TRIGGER_NODE_ID);
		expect(triggerEdge).toBeDefined();
		expect(nodes).toHaveLength(3); // trigger + 2 agents
		expect(nodes.filter((x) => x.type === 'agent')).toHaveLength(2);
		// entry chain: trigger → first → second
		const firstId = triggerEdge!.target;
		const nextEdge = edges.find((e) => e.source === firstId);
		expect(nextEdge).toBeDefined();
		expect(hasCycle(nodes, edges, true)).toBe(false);
	});

	it('throws on empty nodes, duplicate keys, and unknown entry', () => {
		expect(() => specToGraph({ entry: 'x', nodes: [] } as unknown as WorkflowSpec)).toThrow(/at least one node/);
		expect(() =>
			specToGraph({
				entry: 'a',
				nodes: [
					{ key: 'a', type: 'agent', name: 'A', instruction: 'x' },
					{ key: 'a', type: 'agent', name: 'B', instruction: 'y' },
				],
			} as unknown as WorkflowSpec),
		).toThrow(/unique/);
		expect(() =>
			specToGraph({
				entry: 'missing',
				nodes: [{ key: 'a', type: 'agent', name: 'A', instruction: 'x' }],
			} as unknown as WorkflowSpec),
		).toThrow(/not a defined node key/);
	});

	it('throws on unknown next reference', () => {
		expect(() =>
			specToGraph({
				entry: 'a',
				nodes: [{ key: 'a', type: 'agent', name: 'A', instruction: 'x', next: 'nope' }],
			} as unknown as WorkflowSpec),
		).toThrow(/unknown node key/);
	});

	it('rewrites {{steps.<key>.output}} references to generated ids', () => {
		const { nodes } = specToGraph(
			spec({
				nodes: [
					{ key: 'first', type: 'agent', name: 'First', instruction: 'do first', next: 'second' },
					{
						key: 'second',
						type: 'agent',
						name: 'Second',
						instruction: 'use {{steps.first.output}} here',
					},
				],
			}),
		);
		const second = nodes.find((x) => x.type === 'agent' && (x.data as WorkflowStep).name === 'Second');
		const first = nodes.find((x) => x.type === 'agent' && (x.data as WorkflowStep).name === 'First');
		const instruction = (second!.data as WorkflowStep).instruction;
		expect(instruction).toContain(`{{steps.${first!.id}.output}}`);
		expect(instruction).not.toContain('steps.first.output');
	});

	it('creates loop body edges including the back-edge', () => {
		const { nodes, edges } = specToGraph({
			entry: 'loop',
			nodes: [
				{ key: 'loop', type: 'loop', name: 'L', loopMode: 'forEach', body: ['body-step'] },
				{ key: 'body-step', type: 'agent', name: 'Body', instruction: 'work' },
			],
		} as unknown as WorkflowSpec);
		const loopNode = nodes.find((x) => x.type === 'loop')!;
		const backEdge = edges.find((e) => e.targetHandle === 'loopBack');
		expect(backEdge).toBeDefined();
		expect(backEdge!.target).toBe(loopNode.id);
		// The loop cycle itself is not flagged when loopBack edges are ignored
		expect(hasCycle(nodes, edges, true)).toBe(false);
	});
});
