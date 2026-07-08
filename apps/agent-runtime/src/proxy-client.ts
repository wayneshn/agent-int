import type {
	ProxyRequest,
	ProxyResponse,
	AgentMessage,
	AgentRuntimeConfig,
	LlmProxyRequest,
	ContentBlock,
	HitlRequest,
	HitlResponse,
	MemoryWriteRequest,
	MemorySearchRequest,
	MemoryDeleteRequest,
	MemoryDeleteResponse,
	AgentCollaboratorSummary,
	AgentMessageResult,
	AgentAskStartResult,
	AgentAskPollResult,
	AgentAskResult,
	BrowserActionRequest,
	BrowserActionResult,
	SkillTraceRequestBody,
	AgentMemoryEntry,
	AgentMemorySearchResult,
	WorkflowRunStatus,
	WorkflowStepLogStatus,
	WorkflowSummary,
	Workflow,
	WorkflowSpec,
	ChatFile,
	MissionEvent,
	MissionLogRequest,
	MissionScheduleWakeRequest,
	MissionScheduleWakeResult,
	MissionReportRequest,
	MissionApprovalCreateResult,
	AgentMission,
	CreateMissionRequest,
	UpdateMissionRequest,
	MissionControlAction,
} from '@repo/types';

// Per-call request timeouts. Without them, an unreachable backend (e.g. a runtime
// container that cannot resolve PROXY_HOST in a misconfigured Docker deployment)
// makes every fetch hang until the host's 40-min hard kill — orphaning the run and
// holding a concurrency slot. Tight on control-plane calls that only touch the
// backend DB; generous on the two calls that can legitimately run for minutes (LLM
// completion and the credential-proxied external API). Both overridable via env.
const CONTROL_TIMEOUT_MS = parseInt(process.env.RUNTIME_PROXY_CONTROL_TIMEOUT_MS ?? '120000', 10);
const IO_TIMEOUT_MS = parseInt(process.env.RUNTIME_PROXY_IO_TIMEOUT_MS ?? '600000', 10);

// ask_agent polling cadence and overall deadline. The deadline sits slightly above
// the host's 20-min ask window (AGENT_MESSAGE_ASK_TIMEOUT_MS) so the host's own
// timeout resolves first with a clean error. Both overridable via env.
const ASK_POLL_INTERVAL_MS = parseInt(process.env.RUNTIME_ASK_POLL_INTERVAL_MS ?? '5000', 10);
const ASK_OVERALL_TIMEOUT_MS = parseInt(
	process.env.RUNTIME_ASK_OVERALL_TIMEOUT_MS ?? String(25 * 60 * 1000),
	10,
);

/**
 * HTTP client for communication between the agent sandbox and the host backend.
 *
 * All requests are authenticated with the PROXY_TOKEN — a short-lived JWT scoped
 * to this agent/thread/credential-set. The token is never persisted; it is passed
 * in as a constructor argument from the environment at container startup.
 *
 * Endpoints used:
 *   POST /v1/runtime/internal/proxy                  — credential API proxy
 *   POST /v1/runtime/internal/llm/stream             — LLM completion proxy
 *   GET  /v1/runtime/internal/thread/:id/messages    — load conversation history
 *   POST /v1/runtime/internal/thread/:id/messages    — append a message
 *   POST /v1/runtime/internal/memory/write           — write a memory entry (host embeds + stores)
 *   POST /v1/runtime/internal/memory/search          — search memory by semantic similarity
 *   POST /v1/runtime/internal/skills/trace           — record a skill execution trace
 *   POST /v1/runtime/internal/workflow/step-start    — log workflow step start
 *   POST /v1/runtime/internal/workflow/step-end      — log workflow step completion
 *   POST /v1/runtime/internal/workflow/run-complete  — mark workflow run complete
 */
export class ProxyClient {
	private readonly baseUrl: string;
	private readonly proxyToken: string;
	private readonly threadId: string;

	constructor(proxyHost: string, proxyToken: string, threadId: string) {
		this.baseUrl = proxyHost;
		this.proxyToken = proxyToken;
		this.threadId = threadId;
	}

	// ─── Auth helper ──────────────────────────────────────────────────────────

	private authHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.proxyToken}`,
			'Content-Type': 'application/json',
		};
	}

	// ─── Credential proxy ─────────────────────────────────────────────────────

	/**
	 * Execute an authenticated API call via the host credential proxy.
	 * The host resolves the credential, executes the HTTP request, and returns
	 * the response. Raw credential values never enter this process.
	 */
	async proxy(request: ProxyRequest): Promise<ProxyResponse> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/proxy`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(IO_TIMEOUT_MS),
		});

		const json = (await res.json()) as { success: boolean; data?: ProxyResponse; error?: string };
		if (!json.success || !json.data) {
			throw new Error(`Proxy request failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	// ─── LLM proxy ────────────────────────────────────────────────────────────

	/**
	 * Execute an LLM completion via the host LLM proxy.
	 * The host resolves the API key, calls the LLM provider, streams events to
	 * the browser, persists the assistant message, and returns the content blocks
	 * so the agent loop can continue its tool execution cycle.
	 */
	async llmStream(request: LlmProxyRequest): Promise<ContentBlock[]> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/llm/stream`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(IO_TIMEOUT_MS),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: { content: ContentBlock[] };
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`LLM proxy failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data.content;
	}

	// ─── Message history ─────────────────────────────────────────────────────

	/** Load the full conversation history for this thread */
	async loadMessages(): Promise<AgentMessage[]> {
		const res = await fetch(
			`${this.baseUrl}/v1/runtime/internal/thread/${this.threadId}/messages`,
			{ headers: this.authHeaders(), signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) },
		);

		const json = (await res.json()) as {
			success: boolean;
			data?: AgentMessage[];
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Failed to load messages: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/** Append a tool result message to the thread */
	async appendToolResult(input: {
		toolCallId: string;
		toolName: string;
		content: ContentBlock[];
	}): Promise<void> {
		const res = await fetch(
			`${this.baseUrl}/v1/runtime/internal/thread/${this.threadId}/messages`,
			{
				method: 'POST',
				headers: this.authHeaders(),
				body: JSON.stringify({
					role: 'tool_result',
					content: input.content,
					toolCallId: input.toolCallId,
					toolName: input.toolName,
				}),
				signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
			},
		);

		const json = (await res.json()) as { success: boolean; error?: string };
		if (!json.success) {
			throw new Error(`Failed to append tool result: ${json.error ?? 'unknown error'}`);
		}
	}

	// ─── HITL ─────────────────────────────────────────────────────────────────

	/**
	 * Block execution until a human operator responds.
	 *
	 * Calls POST /v1/runtime/internal/hitl/request — this is a long-polling
	 * request that holds the HTTP connection open until the backend resolves it
	 * (when the human sends their next chat message).
	 *
	 * Uses a 35-minute timeout — slightly longer than the backend's 30-minute
	 * HITL window to avoid a Node fetch timeout racing the backend reject.
	 */
	async hitlRequest(request: HitlRequest): Promise<HitlResponse> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/hitl/request`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(35 * 60 * 1000),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: HitlResponse;
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`HITL request failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	// ─── Memory ───────────────────────────────────────────────────────────────

	/**
	 * Write a memory entry for this agent.
	 *
	 * The host embeds the content using the agent's configured embedding model
	 * and persists the entry to the agent_memory table. The sandbox never calls
	 * the embedding API directly — no API keys are available here.
	 *
	 * agentId is derived from the PROXY_TOKEN on the host; the sandbox cannot
	 * write to another agent's memory.
	 */
	async memoryWrite(request: MemoryWriteRequest): Promise<AgentMemoryEntry> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/memory/write`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: AgentMemoryEntry;
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Memory write failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/**
	 * Search this agent's memory by semantic similarity.
	 *
	 * The host embeds the query text and returns the nearest memory entries
	 * ranked by cosine similarity. The sandbox cannot access another agent's memory.
	 */
	async memorySearch(request: MemorySearchRequest): Promise<AgentMemorySearchResult[]> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/memory/search`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: AgentMemorySearchResult[];
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Memory search failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/**
	 * Delete one or more memory entries for this agent.
	 *
	 * The host enforces the agentId from the PROXY_TOKEN — the sandbox cannot
	 * delete memory entries belonging to any other agent.
	 *
	 * @returns { deletedCount } — number of rows actually removed.
	 */
	async memoryDelete(request: MemoryDeleteRequest): Promise<MemoryDeleteResponse> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/memory/delete`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: MemoryDeleteResponse;
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Memory delete failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	// ─── Skill traces ─────────────────────────────────────────────────────────

	/**
	 * Record one skill execution trace for the evolution engine.
	 * The host enforces the agentId from the PROXY_TOKEN and validates that the
	 * skill is actually assigned to this agent.
	 */
	async recordSkillTrace(request: SkillTraceRequestBody): Promise<void> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/skills/trace`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as { success: boolean; error?: string };
		if (!json.success) {
			throw new Error(`Skill trace failed: ${json.error ?? 'unknown error'}`);
		}
	}

	// ─── Workflow step logging ────────────────────────────────────────────────

	/**
	 * Log the start of a workflow step execution.
	 * Returns the stepLogId to be used when logging the step's completion.
	 */
	async logWorkflowStepStart(input: {
		runId: string;
		stepId: string;
		stepIndex: number;
		stepName: string;
		inputContext: Record<string, unknown>;
		attemptNumber?: number;
	}): Promise<string> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/workflow/step-start`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: { stepLogId: string };
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Workflow step start failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data.stepLogId;
	}

	/**
	 * Log the completion (success, failed, or skipped) of a workflow step.
	 */
	async logWorkflowStepEnd(input: {
		stepLogId: string;
		status: WorkflowStepLogStatus;
		outputData?: Record<string, unknown>;
		error?: string;
	}): Promise<void> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/workflow/step-end`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as { success: boolean; error?: string };
		if (!json.success) {
			throw new Error(`Workflow step end failed: ${json.error ?? 'unknown error'}`);
		}
	}

	/**
	 * Mark a workflow run as completed or errored.
	 * Called after all steps finish (or on a fatal failure that stops the pipeline).
	 */
	async completeWorkflowRun(input: {
		runId: string;
		status: WorkflowRunStatus;
		error?: string;
	}): Promise<void> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/workflow/run-complete`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as { success: boolean; error?: string };
		if (!json.success) {
			throw new Error(`Workflow run complete failed: ${json.error ?? 'unknown error'}`);
		}
	}

	// ─── Workflow agent tools ─────────────────────────────────────────────────

	/**
	 * List all enabled workflows for this agent.
	 * The host scopes the query to sandboxToken.agentId.
	 */
	async listWorkflows(): Promise<WorkflowSummary[]> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/workflow/list`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: WorkflowSummary[];
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`List workflows failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/**
	 * Read the full definition of a single workflow (including steps).
	 * Only workflows belonging to this agent are accessible.
	 */
	async readWorkflow(workflowId: string): Promise<Workflow> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/workflow/${workflowId}`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: Workflow;
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Read workflow failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/**
	 * Create a new workflow for this agent.
	 * The agent provides name, description, step definitions, and optional trigger config.
	 * The host validates (via Zod) and persists the workflow + trigger.
	 * Returns the full created Workflow object including its trigger and generated ID.
	 */
	async createWorkflow(input: {
		name: string;
		description?: string;
		/** Linear sequence of steps. Provide this OR `graph` (for branching/looping). */
		steps?: Array<{
			name: string;
			instruction: string;
			allowedTools?: string[];
			allowedCredentialIds?: string[];
			errorHandlingAction?: 'stop' | 'continue' | 'retry';
		}>;
		/** High-level graph spec for branching (conditions) and loops. */
		graph?: WorkflowSpec;
		trigger?: {
			kind?: 'manual' | 'cron' | 'webhook';
			name?: string;
			/** For cron: { schedule, timezone? }. For manual/webhook: omit. */
			config?: Record<string, string>;
			description?: string;
		};
	}): Promise<Workflow> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/workflow/create`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: Workflow;
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Create workflow failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/**
	 * Trigger a workflow run (fire-and-forget).
	 * The host creates a workflow_run record and spawns a new child process.
	 * Returns immediately with the runId.
	 */
	async triggerWorkflow(
		workflowId: string,
		payload?: Record<string, string | number | boolean | null>,
	): Promise<{ runId: string }> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/workflow/${workflowId}/trigger`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify({ payload }),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: { runId: string };
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Trigger workflow failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	// ─── Agent-to-agent messaging ──────────────────────────────────────────────

	/**
	 * List the agents this agent is permitted to message (its collaborator allow-list).
	 * The host scopes the query to sandboxToken.agentId.
	 */
	async listAgents(): Promise<AgentCollaboratorSummary[]> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/agents`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: AgentCollaboratorSummary[];
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`List agents failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/**
	 * Send a message to another agent (async hand-off). The host spawns the target
	 * agent (reusing the existing delegation thread for follow-ups) and returns
	 * immediately with the thread id. The target runs independently — no result is
	 * streamed back to this turn.
	 */
	async sendToAgent(
		targetAgentId: string,
		message: string,
		context?: string,
	): Promise<AgentMessageResult> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/agent/${targetAgentId}/message`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify({ message, context }),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: AgentMessageResult;
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Send to agent failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/**
	 * Ask another agent and wait for its answer (delegation with a result). The host
	 * spawns the target and returns 202 + threadId immediately; this client then POLLS
	 * the ask-result endpoint until the target's run settles. Polling (short requests)
	 * rather than one held connection because undici's default 5-min headersTimeout
	 * would abort any longer delegation regardless of the abort signal. The overall
	 * deadline (25 min) sits slightly above the host's 20-min ask window so the host's
	 * own timeout resolves first with a clean error.
	 */
	async askAgent(
		targetAgentId: string,
		message: string,
		context?: string,
	): Promise<AgentAskResult> {
		const started = await fetch(`${this.baseUrl}/v1/runtime/internal/agent/${targetAgentId}/ask`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify({ message, context }),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		const startJson = (await started.json()) as {
			success: boolean;
			data?: AgentAskStartResult;
			error?: string;
		};
		if (!startJson.success || !startJson.data) {
			throw new Error(`Ask agent failed: ${startJson.error ?? 'unknown error'}`);
		}
		const { threadId } = startJson.data;

		const deadline = Date.now() + ASK_OVERALL_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, ASK_POLL_INTERVAL_MS));

			let poll: AgentAskPollResult;
			try {
				const res = await fetch(`${this.baseUrl}/v1/runtime/internal/agent/ask/${threadId}`, {
					headers: this.authHeaders(),
					signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
				});
				const json = (await res.json()) as {
					success: boolean;
					data?: AgentAskPollResult;
					error?: string;
				};
				if (!json.success || !json.data) {
					// 404 = the pending ask is gone (swept or host restarted) — terminal.
					throw new Error(`Ask agent failed: ${json.error ?? 'unknown error'}`);
				}
				poll = json.data;
			} catch (err) {
				// Transient network errors must not kill a delegation that is still
				// running host-side — keep polling until the deadline. Terminal host
				// answers ("Ask agent failed: …") are re-thrown.
				if (err instanceof Error && err.message.startsWith('Ask agent failed:')) throw err;
				continue;
			}

			if (poll.status === 'completed') {
				return { response: poll.response, threadId: poll.threadId };
			}
			if (poll.status === 'error') {
				throw new Error(`Ask agent failed: ${poll.error}`);
			}
			// status 'running' — keep polling
		}
		throw new Error('Ask agent failed: timed out waiting for the agent to finish.');
	}

	// ─── Browser ──────────────────────────────────────────────────────────────

	/**
	 * Execute one browser command via the host-managed browser.
	 *
	 * The host owns the browser (a separate container or a local Playwright
	 * instance) and enforces the hard gate (project feature flag + a live DB read
	 * of the agent's internet-access setting). Uses the long IO timeout because
	 * navigation / screenshots can take many seconds.
	 */
	async browserAction(request: BrowserActionRequest): Promise<BrowserActionResult> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/browser/action`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(IO_TIMEOUT_MS),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: BrowserActionResult;
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Browser action failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	// ─── Files ────────────────────────────────────────────────────────────────

	/**
	 * Share a file from the agent workspace back to the user. The host copies the
	 * file from the workspace into the chat-files store, links it to the current
	 * message, and pushes it to the chat UI. Returns the persisted ChatFile.
	 */
	async shareFile(path: string): Promise<ChatFile> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/files/share`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify({ path }),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as { success: boolean; data?: ChatFile; error?: string };
		if (!json.success || !json.data) {
			throw new Error(`Share file failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	// ─── Mission (autonomous long-term goals) ─────────────────────────────────
	// All mission endpoints are authorized by the missionId claim in the
	// PROXY_TOKEN — the sandbox never supplies a mission id.

	/** Rewrite the mission's plan document (persistent memory across wakes) */
	async missionUpdatePlan(plan: string): Promise<void> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/mission/plan`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify({ plan }),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		const json = (await res.json()) as { success: boolean; error?: string };
		if (!json.success) {
			throw new Error(`Mission plan update failed: ${json.error ?? 'unknown error'}`);
		}
	}

	/** Append an entry to the mission activity journal */
	async missionLog(input: MissionLogRequest): Promise<MissionEvent> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/mission/log`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		const json = (await res.json()) as { success: boolean; data?: MissionEvent; error?: string };
		if (!json.success || !json.data) {
			throw new Error(`Mission log failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/** Schedule the next wake; returns the ACTUAL (host-clamped) wake time */
	async missionScheduleNextWake(
		input: MissionScheduleWakeRequest,
	): Promise<MissionScheduleWakeResult> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/mission/schedule`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		const json = (await res.json()) as {
			success: boolean;
			data?: MissionScheduleWakeResult;
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Mission schedule failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/** Declare the mission's goal achieved (or permanently unachievable) */
	async missionComplete(summary: string): Promise<void> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/mission/complete`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify({ summary }),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		const json = (await res.json()) as { success: boolean; error?: string };
		if (!json.success) {
			throw new Error(`Mission complete failed: ${json.error ?? 'unknown error'}`);
		}
	}

	/** Send a proactive progress report to the owner; returns delivery channels */
	async missionReport(input: MissionReportRequest): Promise<{ delivered: string[] }> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/mission/report`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		const json = (await res.json()) as {
			success: boolean;
			data?: { delivered: string[] };
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Mission report failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/** Raise an ASYNC approval request (returns immediately — no waiting) */
	async missionRequestApproval(
		action: string,
		rationale: string,
	): Promise<MissionApprovalCreateResult> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/mission/approval`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify({ action, rationale }),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		const json = (await res.json()) as {
			success: boolean;
			data?: MissionApprovalCreateResult;
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Approval request failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	// ─── Mission management (chat turns) ──────────────────────────────────────
	// Let the agent set up and control its OWN missions conversationally. All are
	// scoped host-side to the token's agentId + ownerId.

	/** List this agent's missions */
	async listMissions(): Promise<AgentMission[]> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/missions`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		const json = (await res.json()) as { success: boolean; data?: AgentMission[]; error?: string };
		if (!json.success || !json.data) {
			throw new Error(`List missions failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/** Read one of this agent's missions */
	async readMission(missionId: string): Promise<AgentMission> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/missions/${missionId}`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		const json = (await res.json()) as { success: boolean; data?: AgentMission; error?: string };
		if (!json.success || !json.data) {
			throw new Error(`Read mission failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/** Create a mission for this agent (draft unless input.activate) */
	async createMission(input: CreateMissionRequest): Promise<AgentMission> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/missions`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		const json = (await res.json()) as { success: boolean; data?: AgentMission; error?: string };
		if (!json.success || !json.data) {
			throw new Error(`Create mission failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/** Update an existing mission's goal/schedule/budgets/policy */
	async updateMission(missionId: string, input: UpdateMissionRequest): Promise<AgentMission> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/missions/${missionId}/update`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		const json = (await res.json()) as { success: boolean; data?: AgentMission; error?: string };
		if (!json.success || !json.data) {
			throw new Error(`Update mission failed: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}

	/** Control a mission: activate | pause | complete | wake */
	async controlMission(missionId: string, action: MissionControlAction): Promise<void> {
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/missions/${missionId}/control`, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify({ action }),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		const json = (await res.json()) as { success: boolean; error?: string };
		if (!json.success) {
			throw new Error(`Mission ${action} failed: ${json.error ?? 'unknown error'}`);
		}
	}

	// ─── Config ───────────────────────────────────────────────────────────────

	/** Load agent runtime config from the host */
	async loadConfig(): Promise<AgentRuntimeConfig> {
		const configEnv = process.env.RUNTIME_CONFIG;
		if (configEnv) {
			// Config is pre-injected as env var by AgentRuntimeService — no round-trip needed
			return JSON.parse(configEnv) as AgentRuntimeConfig;
		}

		// Fallback: fetch from host (e.g. for long-running containers)
		const res = await fetch(`${this.baseUrl}/v1/runtime/internal/config`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const json = (await res.json()) as {
			success: boolean;
			data?: AgentRuntimeConfig;
			error?: string;
		};
		if (!json.success || !json.data) {
			throw new Error(`Failed to load config: ${json.error ?? 'unknown error'}`);
		}
		return json.data;
	}
}
