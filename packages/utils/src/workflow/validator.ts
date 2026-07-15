import { z } from 'zod';
import type { WorkflowNode, WorkflowEdge } from '@repo/types';
import { hasCycle } from './graph.js';

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

/**
 * JSON Schema object — must be a plain object.
 * We accept any Record<string, unknown> here since the full JSON Schema spec
 * is not validated at this layer — only structural well-formedness is checked.
 * Runtime validation against the schema is done by the workflow runner.
 */
const jsonSchemaSchema = z.record(z.string(), z.unknown());

const workflowStepErrorHandlingSchema = z.object({
	action: z.enum(['stop', 'continue', 'retry']),
	/** Only used when action === 'retry'. Must be between 1 and 10 */
	maxRetries: z.number().int().min(1).max(10).optional(),
	/** Applied after retries are exhausted */
	fallbackAction: z.enum(['stop', 'continue']).optional(),
});

// Conditions have two branches, so 'continue' has no well-defined target — they
// are retry-then-stop only.
const conditionErrorHandlingSchema = z.object({
	action: z.enum(['stop', 'retry']),
	/** Only used when action === 'retry'. Must be between 1 and 10 */
	maxRetries: z.number().int().min(1).max(10).optional(),
});

export const workflowStepSchema = z.object({
	id: z.uuid('Step id must be a valid UUID'),
	name: z.string().min(1, 'Step name is required').max(255),
	instruction: z.string().min(1, 'Step instruction is required'),
	inputMapping: z.string().optional(),
	/**
	 * Empty array = all tools allowed. Non-empty = strict subset.
	 */
	allowedTools: z.array(z.string()).default([]),
	/** Explicit "use all of the agent's tools" intent (overrides allowedTools). */
	allTools: z.boolean().default(false),
	/**
	 * Empty array = all agent credentials allowed. Non-empty = strict subset.
	 */
	allowedCredentialIds: z.array(z.uuid()).default([]),
	/** Explicit "use all credentials assigned to the agent" intent (overrides the list). */
	allCredentials: z.boolean().default(false),
	/**
	 * Maximum tool calls allowed per step tool loop. Default is 20.
	 * Each step runs like a chat turn — the agent can call tools repeatedly
	 * until it completes the step's instruction. This cap prevents runaway loops.
	 */
	maxToolCallsPerStep: z.number().int().min(1).max(100).optional(),
	/**
	 * Optional JSON Schema object. When present, the workflow runner enforces
	 * the LLM output must conform to this schema.
	 */
	expectedResponseSchema: jsonSchemaSchema.optional(),
	errorHandling: workflowStepErrorHandlingSchema,
});

// ─── Graph sub-schemas ──────────────────────────────────────────────────────────

const positionSchema = z.object({ x: z.number(), y: z.number() });

const filterOperatorSchema = z.enum([
	'equals',
	'notEquals',
	'contains',
	'notContains',
	'gt',
	'gte',
	'lt',
	'lte',
	'isEmpty',
	'isNotEmpty',
	'isTrue',
	'isFalse',
	'exists',
	'notExists',
]);

const filterConditionSchema = z.object({
	left: z.string(),
	operator: filterOperatorSchema,
	right: z.string().optional(),
});

const filterValueSchema = z.object({
	combinator: z.enum(['and', 'or']),
	conditions: z.array(filterConditionSchema),
});

const triggerNodeDataSchema = z.object({ label: z.string().optional() });

const evalModeSchema = z.enum(['smart', 'manual']);

const conditionNodeDataSchema = z
	.object({
		name: z.string().min(1, 'Condition name is required').max(255),
		evalMode: evalModeSchema.optional(),
		prompt: z.string().optional(),
		filter: filterValueSchema.optional(),
		errorHandling: conditionErrorHandlingSchema.optional(),
	})
	.superRefine((data, ctx) => {
		const mode = data.evalMode ?? 'smart';
		if (mode === 'manual') {
			if (!data.filter || data.filter.conditions.length === 0) {
				ctx.addIssue({
					code: 'custom',
					path: ['filter'],
					message: 'Add at least one rule (or switch to Smart mode)',
				});
			}
		} else if (!data.prompt || !data.prompt.trim()) {
			ctx.addIssue({
				code: 'custom',
				path: ['prompt'],
				message: 'Describe the condition for the agent to evaluate',
			});
		}
	});

const loopNodeDataSchema = z
	.object({
		name: z.string().min(1, 'Loop name is required').max(255),
		mode: z.enum(['forEach', 'while']),
		items: z.string().optional(),
		evalMode: evalModeSchema.optional(),
		prompt: z.string().optional(),
		condition: filterValueSchema.optional(),
		maxIterations: z.number().int().min(1).max(1000),
	})
	.superRefine((data, ctx) => {
		if (data.mode !== 'while') return;
		const mode = data.evalMode ?? 'smart';
		if (mode === 'manual') {
			if (!data.condition || data.condition.conditions.length === 0) {
				ctx.addIssue({
					code: 'custom',
					path: ['condition'],
					message: 'Add at least one rule (or switch to Smart mode)',
				});
			}
		} else if (!data.prompt || !data.prompt.trim()) {
			ctx.addIssue({
				code: 'custom',
				path: ['prompt'],
				message: 'Describe when the loop should continue',
			});
		}
	});

const workflowNodeSchema = z.discriminatedUnion('type', [
	z.object({
		id: z.string().min(1),
		type: z.literal('trigger'),
		position: positionSchema,
		data: triggerNodeDataSchema.default({}),
	}),
	z.object({
		id: z.uuid('Agent node id must be a valid UUID'),
		type: z.literal('agent'),
		position: positionSchema,
		data: workflowStepSchema,
	}),
	z.object({
		id: z.string().min(1),
		type: z.literal('condition'),
		position: positionSchema,
		data: conditionNodeDataSchema,
	}),
	z.object({
		id: z.string().min(1),
		type: z.literal('loop'),
		position: positionSchema,
		data: loopNodeDataSchema,
	}),
]);

const workflowEdgeSchema = z.object({
	id: z.string().min(1),
	source: z.string().min(1),
	sourceHandle: z.string().optional(),
	target: z.string().min(1),
	targetHandle: z.string().optional(),
	label: z.string().optional(),
});

type ParsedNode = z.infer<typeof workflowNodeSchema>;
type ParsedEdge = z.infer<typeof workflowEdgeSchema>;

/**
 * Graph-level invariants applied via superRefine:
 *  - unique node ids
 *  - exactly one trigger node
 *  - at least one agent (step) node
 *  - agent node id matches its embedded step id
 *  - every edge references existing nodes
 *  - acyclic, except for intentional loop back-edges (targetHandle 'loopBack')
 */
function refineGraph(graph: { nodes: ParsedNode[]; edges: ParsedEdge[] }, ctx: z.RefinementCtx) {
	const { nodes, edges } = graph;

	const ids = nodes.map((n) => n.id);
	if (new Set(ids).size !== ids.length) {
		ctx.addIssue({
			code: 'custom',
			path: ['nodes'],
			message: 'All node IDs must be unique within the workflow',
		});
	}
	const idSet = new Set(ids);

	const triggerCount = nodes.filter((n) => n.type === 'trigger').length;
	if (triggerCount !== 1) {
		ctx.addIssue({
			code: 'custom',
			path: ['nodes'],
			message: 'Workflow must have exactly one trigger node',
		});
	}

	const agentNodes = nodes.filter((n) => n.type === 'agent');
	if (agentNodes.length === 0) {
		ctx.addIssue({
			code: 'custom',
			path: ['nodes'],
			message: 'Workflow must have at least one step',
		});
	}
	for (const n of agentNodes) {
		if (n.type === 'agent' && n.id !== n.data.id) {
			ctx.addIssue({
				code: 'custom',
				path: ['nodes'],
				message: `Step node "${n.data.name || n.id}" id must match its step id`,
			});
		}
	}

	for (const e of edges) {
		if (!idSet.has(e.source)) {
			ctx.addIssue({
				code: 'custom',
				path: ['edges'],
				message: `Edge ${e.id} references an unknown source node`,
			});
		}
		if (!idSet.has(e.target)) {
			ctx.addIssue({
				code: 'custom',
				path: ['edges'],
				message: `Edge ${e.id} references an unknown target node`,
			});
		}
	}

	if (hasCycle(nodes as WorkflowNode[], edges as WorkflowEdge[], true)) {
		ctx.addIssue({
			code: 'custom',
			path: ['edges'],
			message: 'Workflow graph must not contain cycles (except loop back-edges)',
		});
	}
}

// ─── Create / Update schemas ─────────────────────────────────────────────────────

/**
 * A workflow is accepted in either form:
 *  - graph form: `nodes` (+ optional `edges`) — the source of truth for new clients
 *  - legacy form: a non-empty `steps` array (older clients / pre-graph callers)
 * When `nodes` is present the graph is validated; otherwise the legacy `steps`
 * rules apply.
 */
export const workflowCreateSchema = z
	.object({
		name: z.string().min(1, 'Workflow name is required').max(255),
		description: z.string().optional(),
		steps: z.array(workflowStepSchema).optional(),
		nodes: z.array(workflowNodeSchema).optional(),
		edges: z.array(workflowEdgeSchema).optional(),
		isEnabled: z.boolean().optional().default(true),
	})
	.superRefine((data, ctx) => {
		if (data.nodes && data.nodes.length > 0) {
			refineGraph({ nodes: data.nodes, edges: data.edges ?? [] }, ctx);
		} else if (data.steps && data.steps.length > 0) {
			const stepIds = data.steps.map((s) => s.id);
			if (new Set(stepIds).size !== stepIds.length) {
				ctx.addIssue({
					code: 'custom',
					path: ['steps'],
					message: 'All step IDs must be unique within the workflow',
				});
			}
		} else {
			ctx.addIssue({
				code: 'custom',
				path: ['nodes'],
				message: 'Workflow must have at least one step',
			});
		}
	});

export const workflowUpdateSchema = z
	.object({
		name: z.string().min(1).max(255).optional(),
		description: z.string().optional(),
		steps: z.array(workflowStepSchema).optional(),
		nodes: z.array(workflowNodeSchema).optional(),
		edges: z.array(workflowEdgeSchema).optional(),
		isEnabled: z.boolean().optional(),
	})
	.superRefine((data, ctx) => {
		if (data.nodes !== undefined) {
			if (data.nodes.length === 0) {
				ctx.addIssue({
					code: 'custom',
					path: ['nodes'],
					message: 'Workflow must have at least one step',
				});
			} else {
				refineGraph({ nodes: data.nodes, edges: data.edges ?? [] }, ctx);
			}
		} else if (data.steps !== undefined) {
			if (data.steps.length === 0) {
				ctx.addIssue({
					code: 'custom',
					path: ['steps'],
					message: 'Workflow must have at least one step',
				});
			} else {
				const stepIds = data.steps.map((s) => s.id);
				if (new Set(stepIds).size !== stepIds.length) {
					ctx.addIssue({
						code: 'custom',
						path: ['steps'],
						message: 'All step IDs must be unique within the workflow',
					});
				}
			}
		}
		// Neither nodes nor steps provided → partial update (name/isEnabled/trigger only).
	});

// ─── Exported validator functions ─────────────────────────────────────────────

/**
 * Validates a user-submitted workflow creation payload.
 * Returns the parsed, coerced result or throws a ZodError.
 *
 * @example
 * const validated = validateWorkflowCreate(req.body);
 */
export function validateWorkflowCreate(input: unknown) {
	return workflowCreateSchema.parse(input);
}

/**
 * Validates a user-submitted workflow update payload.
 * All fields are optional — only provided fields are validated.
 * Returns the parsed result or throws a ZodError.
 */
export function validateWorkflowUpdate(input: unknown) {
	return workflowUpdateSchema.parse(input);
}

export type ValidatedWorkflowCreate = z.infer<typeof workflowCreateSchema>;
export type ValidatedWorkflowUpdate = z.infer<typeof workflowUpdateSchema>;
