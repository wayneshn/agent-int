import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { logger } from '@repo/utils';
import type { Workflow, WorkflowSpec } from '@repo/types';
import type { ToolContext } from './types.js';

/** Minimal step input accepted from the agent for a simple LINEAR workflow. */
interface WorkflowStepInput {
	name: string;
	instruction: string;
	allowedTools?: string[];
	allTools?: boolean;
	allowedCredentialIds?: string[];
	allCredentials?: boolean;
	errorHandlingAction?: 'stop' | 'continue' | 'retry';
}

/** Trigger input accepted from the agent when creating a workflow. */
interface WorkflowTriggerInput {
	kind?: 'manual' | 'cron' | 'webhook';
	name?: string;
	/** For cron: { schedule: string, timezone?: string }. For webhook/manual: omit. */
	config?: Record<string, string>;
	description?: string;
}

/**
 * create_workflow — Create a new workflow for this agent.
 *
 * IMPORTANT: This tool must ONLY be called when the user has EXPLICITLY asked to
 * create a workflow. Before calling it, design the workflow, present the full
 * configuration via ask_human, and only proceed after explicit confirmation.
 *
 * Two ways to define the flow:
 *   - `steps`: a simple LINEAR sequence of agent steps (most common).
 *   - `graph`: a node graph with branching (conditions) and/or loops.
 * Provide exactly one. A trigger is always provisioned (defaults to manual).
 */
export function createCreateWorkflowTool(ctx: ToolContext): AgentTool {
	const tool: AgentTool = {
		name: 'create_workflow',
		label: 'Create Workflow',
		description:
			'Create a new automation workflow for this agent. ' +
			'⚠️ RESTRICTED: Only call this when the user has EXPLICITLY asked to create a new workflow. ' +
			'BEFORE calling you MUST: (1) design the workflow, (2) decide the trigger (manual/cron/webhook — for cron explain the schedule in plain English), ' +
			'(3) present the full configuration to the user, (4) use ask_human to get EXPLICIT confirmation. ' +
			'CHOOSE ONE flow definition: ' +
			'• `steps` — a simple LINEAR sequence of agent steps (use for "do A, then B, then C"). ' +
			'• `graph` — a node graph when you need CONDITIONS (branch true/false) or LOOPS (repeat). ' +
			'Each step/agent node is a full agent turn. Conditions and loop "while" checks are evaluated in SMART mode by default — ' +
			'you write the condition in plain language (e.g. "the price is above 1000") and the agent decides true/false from the prior steps\' output. ' +
			'Steps read upstream data via {{steps.<key>.output}} / {{steps.<key>.output.field}} (graph) or {{steps.<index>.output}} (linear), ' +
			'plus {{trigger.payload}} and, inside a loop body, {{loop.item}} / {{loop.index}}. ' +
			'LEAST PRIVILEGE: give each step only the tools and credentials it needs. Set `allTools`/`allCredentials` to true ONLY when a step genuinely requires broad access — these widen the step’s blast radius, so use them cautiously. ' +
			'IMPORTANT: After this tool completes, your reply to the user MUST include ALL ' +
			'markdown links returned in the tool result exactly as they appear — do not omit or paraphrase them.',
		parameters: Type.Object({
			name: Type.String({ description: 'The workflow name (short, descriptive).' }),
			description: Type.Optional(
				Type.String({ description: 'A brief description of what this workflow does.' }),
			),
			steps: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: 'Step name.' }),
						instruction: Type.String({
							description:
								'The full task instruction for this step. Be detailed — this is what the agent executes.',
						}),
						allowedTools: Type.Optional(
							Type.Array(Type.String(), {
								description:
									'Tool names allowed for this step (a restricted subset). ' +
									'Available: call_api, read_file, write_file, list_files, share_file, run_terminal, run_code, ask_human, ' +
									'memory_write, memory_search, memory_delete, list_workflows, read_workflow, trigger_workflow. ' +
									'Use the special token "agent-browser" to grant ALL browser tools (browser_navigate, browser_click, etc.) at once.',
							}),
						),
						allTools: Type.Optional(
							Type.Boolean({
								description:
									'Grant ALL of the agent’s tools for this step (overrides allowedTools). ' +
									'Use sparingly — prefer the minimum tools the step needs.',
							}),
						),
						allowedCredentialIds: Type.Optional(
							Type.Array(Type.String(), {
								description: 'Credential IDs allowed for this step (a restricted subset).',
							}),
						),
						allCredentials: Type.Optional(
							Type.Boolean({
								description:
									'Grant ALL credentials assigned to the agent for this step (overrides allowedCredentialIds). ' +
									'Use sparingly — prefer only the credentials the step needs.',
							}),
						),
						errorHandlingAction: Type.Optional(
							Type.Union([Type.Literal('stop'), Type.Literal('continue'), Type.Literal('retry')], {
								description:
									"On failure: 'stop' (default) halt the run, 'continue' skip & proceed, 'retry' try again.",
							}),
						),
					}),
					{
						description:
							'LINEAR mode: ordered list of agent steps, executed sequentially. Use this OR `graph`, not both.',
					},
				),
			),
			graph: Type.Optional(
				Type.Object(
					{
						entry: Type.String({
							description: 'The `key` of the first node to run after the trigger.',
						}),
						nodes: Type.Array(
							Type.Object({
								key: Type.String({
									description:
										'A unique key you assign (e.g. "fetch", "checkPrice"). Used to wire connections and to reference this node as {{steps.<key>.output}}.',
								}),
								type: Type.Union(
									[Type.Literal('agent'), Type.Literal('condition'), Type.Literal('loop')],
									{ description: "Node type: 'agent' (a step), 'condition' (branch), or 'loop'." },
								),
								name: Type.String({ description: 'Display name for the node.' }),
								instruction: Type.Optional(
									Type.String({ description: 'agent: the full task instruction for this step.' }),
								),
								allowedTools: Type.Optional(
									Type.Array(Type.String(), {
										description:
											'agent: allowed tool names (a restricted subset). ' +
											'Use the special token "agent-browser" to grant ALL browser tools at once.',
									}),
								),
								allTools: Type.Optional(
									Type.Boolean({
										description:
											'agent: grant ALL of the agent’s tools (overrides allowedTools). Use sparingly.',
									}),
								),
								allowedCredentialIds: Type.Optional(
									Type.Array(Type.String(), {
										description: 'agent: allowed credential IDs (a restricted subset).',
									}),
								),
								allCredentials: Type.Optional(
									Type.Boolean({
										description:
											'agent: grant ALL credentials assigned to the agent (overrides allowedCredentialIds). Use sparingly.',
									}),
								),
								errorHandlingAction: Type.Optional(
									Type.Union(
										[Type.Literal('stop'), Type.Literal('continue'), Type.Literal('retry')],
										{
											description:
												'on failure — stop (default), continue, or retry. agent: all three apply. ' +
												'condition: only stop or retry (retry-then-stop; "continue" is treated as stop ' +
												'since a condition has two branches).',
										},
									),
								),
								maxRetries: Type.Optional(
									Type.Number({
										description:
											'agent/condition: retry count when errorHandlingAction is "retry" (default 1, max 10).',
									}),
								),
								next: Type.Optional(
									Type.String({
										description:
											'agent: key of the next node (omit to end). loop: key of the node to run AFTER the loop finishes.',
									}),
								),
								prompt: Type.Optional(
									Type.String({
										description:
											'condition: the plain-language predicate the agent judges true/false (e.g. "the price is above 1000"). ' +
											'loop (while): the plain-language condition to keep looping while true.',
									}),
								),
								ifTrue: Type.Optional(
									Type.String({ description: 'condition: key to follow when true (omit to end).' }),
								),
								ifFalse: Type.Optional(
									Type.String({
										description: 'condition: key to follow when false (omit to end).',
									}),
								),
								loopMode: Type.Optional(
									Type.Union([Type.Literal('forEach'), Type.Literal('while')], {
										description:
											"loop: 'forEach' iterates over `items`; 'while' repeats while `prompt` is true. Default 'forEach'.",
									}),
								),
								items: Type.Optional(
									Type.String({
										description:
											'loop forEach: a template resolving to a JSON array, e.g. "{{steps.<key>.output.items}}". The body sees each element as {{loop.item}}.',
									}),
								),
								maxIterations: Type.Optional(
									Type.Number({
										description: 'loop: safety cap on iterations (default 10, max 1000).',
									}),
								),
								body: Type.Optional(
									Type.Array(Type.String(), {
										description:
											'loop: ordered keys of the agent-step nodes that run each iteration (also defined in this `nodes` array).',
									}),
								),
							}),
							{
								description:
									'All nodes (agent steps, conditions, loops). Conditions/loops use SMART evaluation (the agent decides).',
							},
						),
					},
					{
						description:
							'GRAPH mode: nodes + connections for branching/looping workflows. Use this OR `steps`, not both.',
					},
				),
			),
			trigger: Type.Optional(
				Type.Object(
					{
						kind: Type.Optional(
							Type.Union([Type.Literal('manual'), Type.Literal('cron'), Type.Literal('webhook')], {
								description:
									"Trigger kind. 'manual': fire on demand. 'cron': scheduled. 'webhook': HTTP. Defaults to 'manual'.",
							}),
						),
						name: Type.Optional(
							Type.String({
								description: 'Display name for this trigger. Defaults to the workflow name.',
							}),
						),
						config: Type.Optional(
							Type.Object(
								{
									schedule: Type.Optional(
										Type.String({
											description:
												"Cron expression (required when kind='cron'). E.g. '0 9 * * 1-5' = weekdays at 9am.",
										}),
									),
									timezone: Type.Optional(
										Type.String({
											description: "IANA timezone for cron. E.g. 'America/New_York'.",
										}),
									),
								},
								{
									description:
										'For cron: provide schedule (and optionally timezone). Else leave empty.',
								},
							),
						),
						description: Type.Optional(
							Type.String({ description: 'Optional description for the trigger.' }),
						),
					},
					{ description: 'Trigger to provision. Defaults to a manual trigger if omitted.' },
				),
			),
		}),
		execute: async (_toolCallId, params) => {
			const { name, description, steps, graph, trigger } = params as {
				name: string;
				description?: string;
				steps?: WorkflowStepInput[];
				graph?: WorkflowSpec;
				trigger?: WorkflowTriggerInput;
			};

			const usingGraph = !!graph && Array.isArray(graph.nodes) && graph.nodes.length > 0;
			if (!usingGraph && (!steps || steps.length === 0)) {
				return {
					content: [
						{
							type: 'text',
							text: 'Provide either `steps` (a linear sequence) or `graph` (for conditions/loops).',
						} as TextContent,
					],
					details: {},
				};
			}

			logger.info(
				{
					workflowName: name,
					mode: usingGraph ? 'graph' : 'steps',
					triggerKind: trigger?.kind ?? 'manual',
				},
				'[agent-runner] create_workflow — creating',
			);

			const workflow: Workflow = await ctx.proxyClient.createWorkflow({
				name,
				description,
				steps: usingGraph ? undefined : steps,
				graph: usingGraph ? graph : undefined,
				trigger,
			});

			logger.info(
				{ workflowId: workflow.id, workflowName: workflow.name },
				'[agent-runner] create_workflow — created',
			);

			// Trigger summary
			const t = workflow.trigger;
			let triggerSummary = 'Manual (fire on demand)';
			if (t?.kind === 'cron') {
				const cronConfig = t.config as { schedule?: string; timezone?: string };
				triggerSummary = `Cron: \`${cronConfig.schedule ?? ''}\`${cronConfig.timezone ? ` (${cronConfig.timezone})` : ''}`;
			} else if (t?.kind === 'webhook') {
				const webhookConfig = t.config as { secret?: string };
				triggerSummary = `Webhook — secret: \`${webhookConfig.secret ?? '(none)'}\``;
			} else if (t?.kind === 'app') {
				triggerSummary = 'App event';
			}

			// Node composition summary
			const agentCount = workflow.nodes.filter((n) => n.type === 'agent').length;
			const conditionCount = workflow.nodes.filter((n) => n.type === 'condition').length;
			const loopCount = workflow.nodes.filter((n) => n.type === 'loop').length;
			const composition =
				`${agentCount} step${agentCount === 1 ? '' : 's'}` +
				(conditionCount ? `, ${conditionCount} condition${conditionCount === 1 ? '' : 's'}` : '') +
				(loopCount ? `, ${loopCount} loop${loopCount === 1 ? '' : 's'}` : '');

			const agentId = ctx.agentId;
			const linksSection = agentId
				? `\n\n**Manage this workflow:**\n` +
					`- [View & edit workflow](/app/agents/${agentId}/workflows/new?workflowId=${workflow.id}&editmode=true)\n` +
					`- [View all workflows](/app/workflows?agentId=${agentId})\n` +
					`- [View runs](/app/agents/${agentId}/workflows/${workflow.id}/runs)`
				: '';

			const textContent: TextContent = {
				type: 'text',
				text:
					`Workflow created successfully!\n` +
					`**Name:** ${workflow.name}\n` +
					`**ID:** \`${workflow.id}\`\n` +
					`**Nodes:** ${composition}\n` +
					`**Trigger:** ${triggerSummary}\n` +
					`\nThe workflow is now saved and ready. ` +
					`Use \`trigger_workflow\` with id \`${workflow.id}\` to run it manually.` +
					linksSection,
			};
			return { content: [textContent], details: {} };
		},
	};

	return tool;
}
