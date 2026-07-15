import type { ApiResponse } from './api.js';
import type { AgentTrigger, AgentTriggerKind, AgentTriggerConfig } from './agentRuntime.js';

// ─── JSON Schema ──────────────────────────────────────────────────────────────

/**
 * A simplified JSON Schema object.
 * The user defines this in the workflow builder to describe what JSON shape
 * a step's LLM output must conform to.
 * Validated by the workflow validator before storage.
 */
export type JsonSchema = Record<string, unknown>;

// ─── Step Definition ──────────────────────────────────────────────────────────

export interface WorkflowStepErrorHandling {
	/**
	 * Action to take if the step fails (tool error, output parse failure, etc.)
	 * 'stop': Halt the entire workflow run and mark it as failed.
	 * 'continue': Ignore the error and proceed to the next step.
	 * 'retry': Re-attempt the step up to `maxRetries` times, then apply `fallbackAction`.
	 */
	action: 'stop' | 'continue' | 'retry';
	/** Only relevant when action === 'retry'. Default: 1 */
	maxRetries?: number;
	/** Applied after retries exhausted. Default: 'stop' */
	fallbackAction?: 'stop' | 'continue';
}

export interface WorkflowStep {
	/** Unique UUID for this step within the workflow */
	id: string;
	/** Human-readable label, e.g. "Fetch Weather Data" */
	name: string;

	/**
	 * The task instruction injected into the agent's prompt for this step.
	 * Combined with the agent's base system instruction at runtime.
	 */
	instruction: string;

	/**
	 * Optional template string for data from prior steps or the trigger payload.
	 * Interpolated before the instruction is sent to the LLM.
	 * Variables: {{trigger.payload}}, {{steps.<nodeId>.output}} (and the legacy
	 * {{steps.<stepIndex>.output}} alias, still supported for older workflows).
	 * If omitted, the runner automatically feeds the predecessor node's output.
	 */
	inputMapping?: string;

	/**
	 * Tool names the agent is allowed to call during this step.
	 * Empty array = all tools available to the agent are allowed.
	 * Specified names = strict subset of available tools for this step only.
	 */
	allowedTools: string[];

	/**
	 * When true, the step may use ALL of the agent's tools, overriding `allowedTools`.
	 * Equivalent to an empty `allowedTools`, but an explicit, user/agent-set intent.
	 * Use sparingly — it widens the step's blast radius. Default false.
	 */
	allTools?: boolean;

	/**
	 * Credential IDs the agent is allowed to use during this step (via call_api).
	 * Empty array = all credentials linked to the agent are allowed.
	 * Specified IDs = strict subset of the agent's linked credentials for this step.
	 * IDs not in the agent's credential list are silently ignored.
	 */
	allowedCredentialIds: string[];

	/**
	 * When true, the step may use ALL credentials assigned to the agent, overriding
	 * `allowedCredentialIds`. Equivalent to an empty list, but an explicit intent.
	 * Never grants credentials the agent isn't assigned. Use sparingly. Default false.
	 */
	allCredentials?: boolean;

	/**
	 * Maximum number of tool calls the agent is allowed to make within this step's
	 * tool loop. This mirrors MAX_TOOL_CALLS_PER_TURN from the chat runner.
	 * Each step runs its own full agent loop (prompt → tool calls → final reply),
	 * and this cap prevents runaway loops within a single step.
	 * Default: 20 (same as the global chat default).
	 */
	maxToolCallsPerStep?: number;

	/**
	 * Optional JSON Schema describing the required output format.
	 * When present:
	 *   - The runner appends a JSON-mode instruction to the prompt.
	 *   - The LLM must respond with a JSON object matching this schema.
	 *   - The runner validates the response; on failure, errorHandling applies.
	 * When absent, the step runs in free-text mode.
	 */
	expectedResponseSchema?: JsonSchema;

	errorHandling: WorkflowStepErrorHandling;
}

// ─── Graph Model: Nodes & Edges ───────────────────────────────────────────────

/**
 * The kind of a node in the workflow graph.
 * - 'trigger': the single entry node. Its config lives on the workflow's trigger
 *   (a separate AgentTrigger entity); this node is a visual anchor only.
 * - 'agent': an agent step — a full agent turn. `data` is a WorkflowStep.
 * - 'condition': branches the flow to a 'true' or 'false' output.
 * - 'loop': iterates a body subgraph over items or while a condition holds.
 */
export type WorkflowNodeType = 'trigger' | 'agent' | 'condition' | 'loop';

/** Canvas position of a node (Svelte Flow coordinate space). */
export interface WorkflowNodePosition {
	x: number;
	y: number;
}

// ── Condition filter (used by condition nodes and loop while-conditions) ──

/**
 * Comparison operators for a single condition.
 * The unary operators (isEmpty/isNotEmpty/isTrue/isFalse/exists/notExists)
 * ignore the `right` operand.
 */
export type FilterOperator =
	| 'equals'
	| 'notEquals'
	| 'contains'
	| 'notContains'
	| 'gt'
	| 'gte'
	| 'lt'
	| 'lte'
	| 'isEmpty'
	| 'isNotEmpty'
	| 'isTrue'
	| 'isFalse'
	| 'exists'
	| 'notExists';

export interface FilterCondition {
	/** Left operand — a template string, e.g. "{{steps.<nodeId>.output.status}}". */
	left: string;
	operator: FilterOperator;
	/** Right operand — template or literal. Omitted for unary operators. */
	right?: string;
}

/** A boolean predicate: a set of conditions combined with and/or. */
export interface FilterValue {
	combinator: 'and' | 'or';
	conditions: FilterCondition[];
}

// ── Node data shapes ──

/** Trigger node carries no execution config (it lives on workflow.trigger). */
export interface WorkflowTriggerNodeData {
	/** Optional cosmetic label shown on the node. */
	label?: string;
}

/**
 * How a condition's true/false (or a loop's while) decision is made.
 * - 'smart': the agent reads a natural-language predicate and decides (default).
 * - 'manual': a deterministic field comparison (FilterValue).
 */
export type WorkflowEvalMode = 'smart' | 'manual';

/**
 * Error handling for a condition node. Unlike a step (single 'out' path), a
 * condition has two branches, so there is no well-defined 'continue' target —
 * conditions are retry-then-stop only.
 */
export interface WorkflowConditionErrorHandling {
	/**
	 * 'stop': halt the run if evaluation fails (default).
	 * 'retry': re-evaluate up to `maxRetries` times, then stop if still failing.
	 */
	action: 'stop' | 'retry';
	/** Only relevant when action === 'retry'. Default: 1 */
	maxRetries?: number;
}

export interface WorkflowConditionNodeData {
	/** Display name for the condition node. */
	name: string;
	/** How the true/false decision is made. Defaults to 'smart' when omitted. */
	evalMode?: WorkflowEvalMode;
	/** smart mode: a natural-language predicate the agent evaluates to true/false. */
	prompt?: string;
	/** manual mode: deterministic field comparison choosing the 'true'/'false' output. */
	filter?: FilterValue;
	/** Retry-on-failure behaviour. Omitted → treated as { action: 'stop' }. */
	errorHandling?: WorkflowConditionErrorHandling;
}

export interface WorkflowLoopNodeData {
	/** Display name for the loop node. */
	name: string;
	/** 'forEach' iterates over `items`; 'while' repeats while the condition holds. */
	mode: 'forEach' | 'while';
	/**
	 * forEach mode: a template resolving to an array,
	 * e.g. "{{steps.<nodeId>.output.items}}".
	 */
	items?: string;
	/** while mode: how the per-iteration condition is evaluated. Defaults to 'smart'. */
	evalMode?: WorkflowEvalMode;
	/** while + smart: a natural-language predicate the agent judges each iteration. */
	prompt?: string;
	/** while + manual: a deterministic predicate evaluated before each iteration. */
	condition?: FilterValue;
	/** Hard safety cap on iterations (prevents runaway loops). */
	maxIterations: number;
}

// ── Node union (discriminated by `type`) ──

interface WorkflowNodeBase {
	id: string;
	position: WorkflowNodePosition;
}

export interface WorkflowTriggerNode extends WorkflowNodeBase {
	type: 'trigger';
	data: WorkflowTriggerNodeData;
}

export interface WorkflowAgentNode extends WorkflowNodeBase {
	type: 'agent';
	/** Full step configuration. By convention node.id === data.id. */
	data: WorkflowStep;
}

export interface WorkflowConditionNode extends WorkflowNodeBase {
	type: 'condition';
	data: WorkflowConditionNodeData;
}

export interface WorkflowLoopNode extends WorkflowNodeBase {
	type: 'loop';
	data: WorkflowLoopNodeData;
}

export type WorkflowNode =
	| WorkflowTriggerNode
	| WorkflowAgentNode
	| WorkflowConditionNode
	| WorkflowLoopNode;

/**
 * A directed connection between two nodes.
 * Handles default to 'out' (source) / 'in' (target). Multi-output nodes use
 * named source handles: condition → 'true' | 'false'; loop → 'loop' | 'done'.
 * A loop's body feeds back via an edge whose target handle is 'loopBack'.
 */
export interface WorkflowEdge {
	id: string;
	source: string;
	sourceHandle?: string;
	target: string;
	targetHandle?: string;
	/** Optional UI label (e.g. "true"/"false"). */
	label?: string;
}

// ─── Agent workflow-authoring spec ────────────────────────────────────────────

/**
 * A high-level workflow description the agent's create_workflow tool can author for
 * branching/looping flows. The host converts it to the real node/edge graph
 * (`specToGraph`): it generates node UUIDs, handles, the loop back-edge, node
 * positions, and rewrites `{{steps.<key>.output}}` references to the generated ids.
 * Connections reference other nodes by their `key`; an omitted connection ends that path.
 */
export interface WorkflowSpecNode {
	/** Unique key the agent assigns, used to wire connections and `{{steps.<key>.output}}`. */
	key: string;
	type: 'agent' | 'condition' | 'loop';
	/** Display name for the node. */
	name: string;

	// ── agent step ──
	/** agent: the task instruction for this step. */
	instruction?: string;
	allowedTools?: string[];
	/** agent: grant all of the agent's tools (overrides allowedTools). */
	allTools?: boolean;
	allowedCredentialIds?: string[];
	/** agent: grant all credentials assigned to the agent (overrides allowedCredentialIds). */
	allCredentials?: boolean;
	errorHandlingAction?: 'stop' | 'continue' | 'retry';
	/**
	 * Retry count when errorHandlingAction === 'retry' (default 1). Applies to agent
	 * steps and conditions. For conditions, 'continue' is not supported (retry-then-stop).
	 */
	maxRetries?: number;
	/** agent / loop: key of the next node after this one (omit to end this path). */
	next?: string;

	// ── condition (Smart, agent-judged) ──
	/** condition / loop-while: the natural-language predicate the agent judges true/false. */
	prompt?: string;
	/** condition: key to follow when the predicate is true (omit to end). */
	ifTrue?: string;
	/** condition: key to follow when the predicate is false (omit to end). */
	ifFalse?: string;

	// ── loop ──
	loopMode?: 'forEach' | 'while';
	/** loop forEach: a template resolving to an array, e.g. "{{steps.<key>.output.items}}". */
	items?: string;
	/** loop: hard safety cap on iterations (default 10). */
	maxIterations?: number;
	/** loop: ordered keys of the body nodes (run in sequence each iteration). */
	body?: string[];
}

export interface WorkflowSpec {
	/** Key of the first node to run after the trigger. */
	entry: string;
	nodes: WorkflowSpecNode[];
}

// ─── Trigger Input (for create/update requests) ───────────────────────────────

/**
 * Trigger configuration provided when creating or updating a workflow.
 * On create, a trigger is always provisioned (defaults to manual kind).
 * On update, if provided, the existing trigger's config is updated.
 */
export interface WorkflowTriggerInput {
	/** Trigger kind. Defaults to 'manual' if not specified. */
	kind?: AgentTriggerKind;
	/**
	 * Human-readable name for the trigger.
	 * Defaults to the workflow name if not specified.
	 */
	name?: string;
	/**
	 * Type-specific configuration.
	 * cron:    { schedule: string, timezone?: string }
	 * webhook: { requireSignature?: boolean } (secret is generated server-side and
	 *          preserved across updates — clients never send it)
	 * manual:  {} (empty)
	 */
	config?: AgentTriggerConfig;
	/** Optional description for this trigger. */
	description?: string;
}

// ─── Workflow Definition ──────────────────────────────────────────────────────

export interface Workflow {
	id: string;
	agentId: string;
	ownerId: string;
	name: string;
	description?: string;
	/**
	 * @deprecated Legacy linear projection of the graph, derived from `nodes`/`edges`
	 * on every save and kept for backward-compatible reads (run-detail timeline,
	 * step-log ordering, list step counts). The graph is the source of truth.
	 */
	steps: WorkflowStep[];
	/** Authoritative graph: nodes (trigger + agent + condition + loop). */
	nodes: WorkflowNode[];
	/** Authoritative graph: directed connections between nodes. */
	edges: WorkflowEdge[];
	isEnabled: boolean;
	/**
	 * The trigger associated with this workflow.
	 * Always present on responses — every workflow has exactly one trigger provisioned at creation.
	 */
	trigger?: AgentTrigger;
	createdAt: Date;
	updatedAt: Date;
}

// ─── Execution & Logging ──────────────────────────────────────────────────────

export type WorkflowRunStatus = 'running' | 'completed' | 'error';
export type WorkflowStepLogStatus = 'running' | 'success' | 'failed' | 'skipped';

/** Represents a single execution of a workflow */
export interface WorkflowRun {
	id: string;
	workflowId: string;
	agentId: string;
	ownerId: string;
	status: WorkflowRunStatus;
	triggerType: 'cron' | 'webhook' | 'manual' | 'app';
	triggerId?: string;
	triggerPayload?: Record<string, unknown>;
	error?: string;
	/**
	 * True when this run was started from the builder's Test mode (a real run with a
	 * user-supplied/fetched trigger payload). Test runs are excluded from the normal runs
	 * history so scheduled/production runs stay clean.
	 */
	isTest?: boolean;
	startedAt: Date;
	completedAt?: Date;
}

/** Represents the log of a single step within a workflow run */
export interface WorkflowStepLog {
	id: string;
	runId: string;
	stepId: string;
	stepIndex: number;
	stepName: string;
	status: WorkflowStepLogStatus;
	/** The specific input context provided to the LLM for this step */
	inputContext: Record<string, unknown>;
	/** The parsed output produced by the LLM (JSON in schema mode, or { text: string }) */
	outputData?: Record<string, unknown>;
	error?: string;
	/** 1-based attempt number; increments on retry */
	attemptNumber: number;
	startedAt: Date;
	completedAt?: Date;
}

// ─── Trigger Context ─────────────────────────────────────────────────────────

/**
 * Normalized trigger context injected into the workflow runner.
 *
 * Built from the raw triggerPayload + triggerType before execution starts.
 * Available to all steps via {{trigger.*}} in inputMapping templates and
 * injected into the system prompt of Step 1.
 *
 * The runner serializes this into the step log's inputContext so the full
 * trigger context is preserved for debugging.
 */
export interface WorkflowTriggerContext {
	/** The trigger type that initiated this run */
	type: 'cron' | 'webhook' | 'manual' | 'app';
	/**
	 * The user-defined trigger name — set when the trigger was created.
	 * e.g. "Slack Incoming Webhook", "Daily Report", "Manual Run"
	 * Copied from AgentTrigger.name at fire time. Always explicitly defined by the user.
	 */
	triggerName: string;
	/**
	 * For app triggers (type === 'app'): the provider id that emitted the event,
	 * e.g. 'gmail', 'notion', 'slack'. Lets the step prompt name the source.
	 */
	appProvider?: string;
	/**
	 * For app triggers (type === 'app'): the event id that fired,
	 * e.g. 'message.received', 'database.itemChanged'.
	 */
	appEvent?: string;
	/**
	 * ISO 8601 timestamp of when the trigger fired.
	 * For cron: the scheduled fire time. For webhook: the request receipt time.
	 */
	firedAt: string;
	/**
	 * The raw payload from the trigger source.
	 * For webhook: the parsed JSON request body (may contain source-specific fields
	 * such as Slack event objects, GitHub webhook payloads, etc.)
	 * For app: the provider's normalized event payload plus a `raw` field carrying the
	 * original API object (e.g. { from, subject, body, receivedAt, messageId, raw }).
	 * For cron: { firedAt: string }.
	 * For manual: { firedAt: string }.
	 */
	payload: Record<string, unknown>;
}

// ─── Workflow Summary (for agent tool use) ────────────────────────────────────

/**
 * Lightweight summary of a workflow returned by the list_workflows agent tool.
 * Does not include steps — the agent can call read_workflow to get the full definition.
 */
export interface WorkflowSummary {
	id: string;
	name: string;
	description?: string;
	/** Number of agent steps in this workflow. */
	stepCount: number;
	/** Number of condition (branch) nodes, if any. */
	conditionCount?: number;
	/** Number of loop nodes, if any. */
	loopCount?: number;
	/** How this workflow is triggered (manual/cron/webhook/app). */
	triggerKind?: AgentTriggerKind;
	isEnabled: boolean;
}

// ─── API Request/Response Bodies ──────────────────────────────────────────────

export interface CreateWorkflowRequestBody {
	name: string;
	description?: string;
	/** @deprecated Provide `nodes`/`edges` instead. Accepted for backward compatibility. */
	steps?: WorkflowStep[];
	/** Graph nodes — the source of truth for new clients. */
	nodes?: WorkflowNode[];
	/** Graph edges. */
	edges?: WorkflowEdge[];
	isEnabled?: boolean;
	/**
	 * Trigger to provision alongside the workflow.
	 * Defaults to a manual trigger named after the workflow if omitted.
	 */
	trigger?: WorkflowTriggerInput;
}

export interface UpdateWorkflowRequestBody {
	name?: string;
	description?: string;
	/** @deprecated Provide `nodes`/`edges` instead. Accepted for backward compatibility. */
	steps?: WorkflowStep[];
	/** Graph nodes — the source of truth for new clients. */
	nodes?: WorkflowNode[];
	/** Graph edges. */
	edges?: WorkflowEdge[];
	isEnabled?: boolean;
	/**
	 * Trigger configuration to update.
	 * When provided, the existing trigger's kind/config/name/description is updated.
	 */
	trigger?: WorkflowTriggerInput;
}

// ─── Webhook Endpoint Response ────────────────────────────────────────────────

/**
 * Data returned to external webhook callers on a successful (202 Accepted) delivery.
 * runId/workflowId are null when the trigger has no workflow attached
 * (legacy standalone triggers that spawn a plain chat thread).
 */
export interface WebhookAccepted {
	received: true;
	runId: string | null;
	workflowId: string | null;
}

export type WebhookAcceptedResponse = ApiResponse<WebhookAccepted>;

// ─── API Response Envelopes ───────────────────────────────────────────────────

export type WorkflowResponse = ApiResponse<Workflow>;
export type WorkflowsListResponse = ApiResponse<Workflow[]>;
export type WorkflowDeleteResponse = ApiResponse<{ deleted: boolean }>;
export type WorkflowRunResponse = ApiResponse<WorkflowRun>;
export type WorkflowRunsListResponse = ApiResponse<{ runs: WorkflowRun[]; total: number }>;
export type WorkflowStepLogsListResponse = ApiResponse<WorkflowStepLog[]>;

/**
 * Request body for starting a Test-mode run from the builder.
 * `stopAfterNodeId` present ⇒ a per-node "Run to here" partial run (the workflow runs from
 * the trigger up to and including that node); absent ⇒ the full workflow.
 */
export interface WorkflowTestRunRequestBody {
	/** The seed trigger payload (user-pasted JSON or a fetched app sample). */
	payload: Record<string, unknown>;
	/** Optional node id to stop after (per-node test). */
	stopAfterNodeId?: string;
}

/** Identifiers of the run a Test-mode request started. */
export interface WorkflowTestRunResult {
	runId: string;
	workflowId: string;
	threadId: string;
}

export type WorkflowTestRunResponse = ApiResponse<WorkflowTestRunResult>;
