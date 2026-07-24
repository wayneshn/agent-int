import { describe, it, expect } from 'vitest';
import { validateWorkflowCreate, validateWorkflowUpdate } from './validator.js';

const UUID_A = '00000000-0000-4000-8000-00000000000a';
const UUID_B = '00000000-0000-4000-8000-00000000000b';

function step(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		name: 'Step',
		instruction: 'do something',
		errorHandling: { action: 'stop' },
		...overrides,
	};
}

function validGraph() {
	return {
		nodes: [
			{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 } },
			{ id: UUID_A, type: 'agent', position: { x: 0, y: 0 }, data: step(UUID_A) },
		],
		edges: [{ id: 'e1', source: 'trigger', target: UUID_A }],
	};
}

describe('validateWorkflowCreate', () => {
	it('accepts a minimal legacy steps workflow and applies defaults', () => {
		const parsed = validateWorkflowCreate({ name: 'W', steps: [step(UUID_A)] });
		expect(parsed.name).toBe('W');
		expect(parsed.steps).toHaveLength(1);
		expect(parsed.steps![0].allowedTools).toEqual([]);
		expect(parsed.steps![0].allTools).toBe(false);
		expect(parsed.isEnabled).toBe(true);
	});

	it('accepts a valid graph-form workflow', () => {
		const parsed = validateWorkflowCreate({ name: 'W', ...validGraph() });
		expect(parsed.nodes).toHaveLength(2);
		expect(parsed.edges).toHaveLength(1);
	});

	it('rejects when neither steps nor nodes are present', () => {
		expect(() => validateWorkflowCreate({ name: 'W' })).toThrow(/at least one step/);
	});

	it('rejects duplicate step ids (legacy form)', () => {
		expect(() => validateWorkflowCreate({ name: 'W', steps: [step(UUID_A), step(UUID_A)] })).toThrow(
			/unique/,
		);
	});

	it('rejects non-UUID step ids', () => {
		expect(() => validateWorkflowCreate({ name: 'W', steps: [step('not-a-uuid')] })).toThrow();
	});

	it('rejects empty instruction and empty name', () => {
		expect(() => validateWorkflowCreate({ name: 'W', steps: [step(UUID_A, { instruction: '' })] })).toThrow();
		expect(() => validateWorkflowCreate({ name: '', steps: [step(UUID_A)] })).toThrow();
	});

	it('rejects errorHandling maxRetries out of range', () => {
		expect(() =>
			validateWorkflowCreate({
				name: 'W',
				steps: [step(UUID_A, { errorHandling: { action: 'retry', maxRetries: 11 } })],
			}),
		).toThrow();
	});

	it('enforces graph invariants', () => {
		// duplicate node ids
		expect(() =>
			validateWorkflowCreate({
				name: 'W',
				nodes: [
					{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 } },
					{ id: 'trigger', type: 'trigger', position: { x: 1, y: 0 } },
					{ id: UUID_A, type: 'agent', position: { x: 2, y: 0 }, data: step(UUID_A) },
				],
			}),
		).toThrow(/unique|exactly one trigger/);

		// missing trigger
		expect(() =>
			validateWorkflowCreate({
				name: 'W',
				nodes: [{ id: UUID_A, type: 'agent', position: { x: 0, y: 0 }, data: step(UUID_A) }],
			}),
		).toThrow(/exactly one trigger/);

		// agent node id must match embedded step id
		expect(() =>
			validateWorkflowCreate({
				name: 'W',
				nodes: [
					{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 } },
					{ id: UUID_A, type: 'agent', position: { x: 0, y: 0 }, data: step(UUID_B) },
				],
			}),
		).toThrow(/must match its step id/);

		// edge to unknown node
		expect(() =>
			validateWorkflowCreate({
				name: 'W',
				nodes: [
					{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 } },
					{ id: UUID_A, type: 'agent', position: { x: 0, y: 0 }, data: step(UUID_A) },
				],
				edges: [{ id: 'e1', source: 'trigger', target: 'ghost' }],
			}),
		).toThrow(/unknown target node/);
	});

	it('rejects accidental cycles but allows loop back-edges', () => {
		const cyclic = {
			name: 'W',
			nodes: [
				{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 } },
				{ id: UUID_A, type: 'agent', position: { x: 0, y: 0 }, data: step(UUID_A) },
				{ id: UUID_B, type: 'agent', position: { x: 0, y: 0 }, data: step(UUID_B) },
			],
			edges: [
				{ id: 'e1', source: 'trigger', target: UUID_A },
				{ id: 'e2', source: UUID_A, target: UUID_B },
				{ id: 'e3', source: UUID_B, target: UUID_A },
			],
		};
		expect(() => validateWorkflowCreate(cyclic)).toThrow(/cycles/);

		// Same shape, but the closing edge is a loop back-edge ⇒ allowed
		const withLoopBack = {
			...cyclic,
			edges: [
				...cyclic.edges.slice(0, 2),
				{ id: 'e3', source: UUID_B, target: UUID_A, targetHandle: 'loopBack' },
			],
		};
		expect(() => validateWorkflowCreate(withLoopBack)).not.toThrow();
	});

	it('condition nodes require a prompt in smart mode and rules in manual mode', () => {
		const condition = (data: Record<string, unknown>) => ({
			name: 'W',
			nodes: [
				{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 } },
				{ id: 'cond-1', type: 'condition', position: { x: 0, y: 0 }, data },
				{ id: UUID_A, type: 'agent', position: { x: 0, y: 0 }, data: step(UUID_A) },
			],
		});
		expect(() => validateWorkflowCreate(condition({ name: 'C' }))).toThrow(/Describe the condition/);
		expect(() =>
			validateWorkflowCreate(condition({ name: 'C', evalMode: 'manual' })),
		).toThrow(/at least one rule/);
		expect(() =>
			validateWorkflowCreate(
				condition({
					name: 'C',
					evalMode: 'manual',
					filter: { combinator: 'and', conditions: [{ left: 'a', operator: 'equals', right: 'b' }] },
				}),
			),
		).not.toThrow();
	});

	it('while-loops require a prompt in smart mode and rules in manual mode', () => {
		const loop = (data: Record<string, unknown>) => ({
			name: 'W',
			nodes: [
				{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 } },
				{ id: 'loop-1', type: 'loop', position: { x: 0, y: 0 }, data },
				{ id: UUID_A, type: 'agent', position: { x: 0, y: 0 }, data: step(UUID_A) },
			],
		});
		const base = { name: 'L', mode: 'while', maxIterations: 5 };
		expect(() => validateWorkflowCreate(loop(base))).toThrow(/when the loop should continue/);
		expect(() => validateWorkflowCreate(loop({ ...base, evalMode: 'manual' }))).toThrow(
			/at least one rule/,
		);
		expect(() =>
			validateWorkflowCreate(loop({ ...base, prompt: 'keep going while incomplete' })),
		).not.toThrow();
		// forEach mode skips the refinement
		expect(() => validateWorkflowCreate(loop({ ...base, mode: 'forEach' }))).not.toThrow();
	});
});

describe('validateWorkflowUpdate', () => {
	it('accepts a partial update with only a name', () => {
		const parsed = validateWorkflowUpdate({ name: 'New name' });
		expect(parsed.name).toBe('New name');
	});

	it('rejects an explicitly empty steps array', () => {
		expect(() => validateWorkflowUpdate({ steps: [] })).toThrow(/at least one step/);
	});

	it('rejects an explicitly empty nodes array', () => {
		expect(() => validateWorkflowUpdate({ nodes: [] })).toThrow(/at least one step/);
	});

	it('validates the graph when nodes are provided', () => {
		expect(() =>
			validateWorkflowUpdate({
				nodes: [{ id: UUID_A, type: 'agent', position: { x: 0, y: 0 }, data: step(UUID_A) }],
			}),
		).toThrow(/exactly one trigger/);
		expect(() => validateWorkflowUpdate(validGraph())).not.toThrow();
	});
});
