import type {
	AgentAskPollResult,
	AgentCollaboratorSummary,
	AgentMessage,
	AgentThreadStatus,
} from '@repo/types';
import { AgentService } from './AgentService.js';
import { AgentSessionService } from './AgentSessionService.js';
import { AgentRuntimeService } from './AgentRuntimeService.js';
import { agentStreamBus } from './AgentStreamBus.js';
import { logger } from '../config/logger.js';

/**
 * Maximum delegation chain length. The chain lists every agent from the root
 * human-initiated turn down to (and including) the agent making the current call, so
 * a value of 5 allows an orchestrator → worker → sub-worker style tree up to five
 * agents deep before further delegation is refused. Bounds runaway fan-out and — for
 * synchronous ask_agent — the number of concurrency slots a single chain can hold.
 */
const MAX_DELEGATION_DEPTH = parseInt(process.env.AGENT_MESSAGE_MAX_DEPTH ?? '5', 10);

/**
 * How long an ask_agent delegation waits for the target's run to finish before
 * giving up. Kept below the 40-min hard run cap so the caller's own run is not killed
 * mid-wait. A timeout marks the pending ask 'error'; the target keeps running in its
 * own thread. Overridable via env.
 */
const ASK_TIMEOUT_MS = parseInt(process.env.AGENT_MESSAGE_ASK_TIMEOUT_MS ?? '1200000', 10);

/**
 * How long a settled ask result stays pollable after the target run finishes. The
 * sandbox polls every few seconds, so anything beyond a couple of intervals is
 * grace for transient network hiccups; after the TTL the entry is swept so a
 * caller that died mid-ask cannot leak memory.
 */
const ASK_RESULT_TTL_MS = 10 * 60 * 1000;

/** Absolute deep link to a thread in the web app. APP_URL is the public frontend URL. */
function buildThreadUrl(agentId: string, threadId: string): string {
	const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
	return `${base}/app/chat/${agentId}/${threadId}`;
}

// ─── Result types ──────────────────────────────────────────────────────────────

/** Async hand-off result — success carries the spawned target thread id + deep link. */
export type SendMessageResult =
	| { ok: true; threadId: string; threadUrl: string }
	| { ok: false; status: number; error: string };

/** Ask initiation result — success means the target is spawned and pollable. */
export type StartAskResult =
	| { ok: true; threadId: string }
	| { ok: false; status: number; error: string };

/** A pending (or settled, still-pollable) ask_agent delegation. */
interface PendingAsk {
	/** Authorization for polling — only the initiating agent+thread may read it */
	callerAgentId: string;
	callerThreadId: string;
	/** The delivered ask message — results are extracted only from messages after it */
	deliveredMessageId: string;
	/** null while the target run is in flight */
	result: AgentAskPollResult | null;
}

interface DelegationInput {
	/** The agent making the call — derived from the PROXY_TOKEN, never the body */
	callerAgentId: string;
	/** The thread the caller is running in — derived from the PROXY_TOKEN */
	callerThreadId: string;
	/** Owner of both agents — derived from the PROXY_TOKEN */
	ownerId: string;
	/** The agent to message */
	targetAgentId: string;
	/** The message to deliver */
	message: string;
	/** Optional brief background from the caller's current task */
	context?: string;
}

/** Prepared target thread, ready to spawn. */
interface PreparedDelegation {
	targetThreadId: string;
	callerName: string;
	targetName: string;
	/** True when an existing delegation thread was reused (follow-up message) */
	reused: boolean;
	/** Id of the just-appended message — deleted again if the spawn never starts */
	deliveredMessageId: string;
}

/**
 * Extract the last non-empty assistant text from a thread's message history.
 * The target's final answer is the most recent assistant message that carries text
 * (i.e. the turn where it stopped calling tools). Returns '' when none is found.
 */
function extractFinalAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== 'assistant') continue;
		const text = m.content
			.filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
			.map((b) => b.text)
			.join('\n')
			.trim();
		if (text) return text;
	}
	return '';
}

/** Format the message delivered to the target, with provenance and optional context. */
function formatDeliveredMessage(callerName: string, message: string, context?: string): string {
	const contextSection = context?.trim()
		? `\n\n[Context provided by «${callerName}»]\n${context.trim()}`
		: '';
	return `[Message from agent «${callerName}»]\n\n${message}${contextSection}`;
}

/**
 * Agent-to-agent (A2A) messaging.
 *
 * Lets one agent hand work to another agent it is explicitly allowed to reach (the
 * per-agent collaborator allow-list). Two modes:
 *   - sendMessage() — async hand-off: spawn the target, return its thread id immediately.
 *   - startAsk() + getAskResult() — delegation with an answer: spawn the target and
 *     let the sandbox POLL for the final text. Polling (not a held connection)
 *     because undici's default 5-min headersTimeout on the sandbox side would kill
 *     any longer delegation on a buffered long-poll response.
 *
 * Conversation continuity: messages from the same caller thread to the same target
 * REUSE the target-side delegation thread, so follow-up questions keep the target's
 * context (it remembers the earlier exchange). A new caller thread starts a fresh
 * target thread.
 *
 * Security model (all host-enforced — the sandbox flags are UX-only):
 *   - The target must be in the caller's collaborator allow-list (default-deny).
 *   - Both agents belong to the same owner (collaborator links are same-owner; the
 *     spawn also re-checks ownership via AgentService.getById).
 *   - The delegation chain is DERIVED from the caller's thread row (never supplied by
 *     the sandbox), so depth and cycle checks cannot be spoofed.
 *   - The target runs under its OWN scoped PROXY_TOKEN and credentials — the caller
 *     never receives the target's secrets.
 */
export class AgentMessagingService {
	/**
	 * Delegations currently between prepare and spawn-settled, keyed by
	 * `${callerThreadId}→${targetAgentId}`. The DB 'running' check alone cannot
	 * prevent a double-spawn: spawnForThread flips the thread to 'running' only
	 * after several awaits, so two quick calls to the same target would both pass
	 * it, append two messages, and spawn twice. The lock is held until the spawn
	 * settles — by which point the thread IS 'running' — closing that window.
	 */
	private readonly inFlight = new Set<string>();

	/** Pending/settled ask_agent delegations, keyed by target thread id. */
	private readonly pendingAsks = new Map<string, PendingAsk>();

	constructor(
		private readonly agentService: AgentService,
		private readonly sessionService: AgentSessionService,
		private readonly runtimeService: AgentRuntimeService,
	) {}

	/**
	 * Best-effort removal of a delivered message whose target run never started
	 * (declined or failed spawn) — otherwise the next delegation reuses the thread
	 * and the target processes the stale, already-reported-as-failed request too
	 * (duplicate side effects).
	 */
	private async rollbackUndelivered(threadId: string, messageId: string): Promise<void> {
		try {
			await this.sessionService.deleteMessageInternal(messageId);
		} catch (err) {
			logger.warn({ err, threadId, messageId }, '[a2a] failed to roll back undelivered message');
		}
	}

	/** List the agents the caller is permitted to message (for the list_agents tool). */
	async listCollaborators(callerAgentId: string): Promise<AgentCollaboratorSummary[]> {
		return this.agentService.listCollaborators(callerAgentId);
	}

	/**
	 * Authorize the call, derive + validate the delegation chain, find-or-create the
	 * target delegation thread, and append the provenance-prefixed message. Shared by
	 * both modes. Returns a typed error result on any guard failure.
	 */
	private async prepareDelegation(
		input: DelegationInput,
	): Promise<{ ok: true; prepared: PreparedDelegation } | { ok: false; status: number; error: string }> {
		const { callerAgentId, callerThreadId, ownerId, targetAgentId, message, context } = input;

		if (!message || !message.trim()) {
			return { ok: false, status: 400, error: 'message is required' };
		}
		if (targetAgentId === callerAgentId) {
			return { ok: false, status: 400, error: 'An agent cannot message itself.' };
		}

		const caller = await this.agentService.getByIdInternal(callerAgentId);
		if (!caller) {
			return { ok: false, status: 404, error: 'Calling agent not found.' };
		}
		// Default-deny allow-list check — the authoritative permission gate.
		if (!caller.collaboratorIds.includes(targetAgentId)) {
			return {
				ok: false,
				status: 403,
				error: 'You are not permitted to message this agent. Use list_agents to see who you can message.',
			};
		}

		const target = await this.agentService.getByIdInternal(targetAgentId);
		if (!target || target.ownerId !== ownerId) {
			// Same-owner is guaranteed by construction, but re-check defensively.
			return { ok: false, status: 404, error: 'Target agent not found.' };
		}

		// Derive the chain from the caller's thread — tamper-proof (server-owned row).
		const callerThread = await this.sessionService.getThreadByIdInternal(callerThreadId);
		const chain = [...(callerThread?.delegationChain ?? []), callerAgentId];

		if (chain.includes(targetAgentId)) {
			return {
				ok: false,
				status: 409,
				error: `Delegation cycle detected — ${target.name} is already an ancestor in this delegation chain.`,
			};
		}
		if (chain.length >= MAX_DELEGATION_DEPTH) {
			return {
				ok: false,
				status: 429,
				error: `Delegation depth limit reached (${MAX_DELEGATION_DEPTH}). This task has been delegated too many times.`,
			};
		}

		// Conversation continuity — reuse the existing delegation thread for this
		// (caller thread → target) pair so follow-ups keep the target's context.
		const existing = await this.sessionService.findDelegationThread(
			targetAgentId,
			callerThreadId,
			callerAgentId,
		);

		let targetThreadId: string;
		let reused = false;
		if (existing) {
			if (existing.status === 'running') {
				return {
					ok: false,
					status: 409,
					error: `${target.name} is still working on your previous message. Wait for it to finish before sending a follow-up.`,
				};
			}
			targetThreadId = existing.id;
			reused = true;
		} else {
			const thread = await this.sessionService.createThread({
				agentId: targetAgentId,
				ownerId,
				title: `Message from ${caller.name}`,
				triggerType: 'agent',
				initiatorAgentId: callerAgentId,
				parentThreadId: callerThreadId,
				delegationChain: chain,
			});
			targetThreadId = thread.id;
		}

		const delivered = await this.sessionService.appendMessage({
			threadId: targetThreadId,
			role: 'user',
			content: [{ type: 'text', text: formatDeliveredMessage(caller.name, message, context) }],
		});

		return {
			ok: true,
			prepared: {
				targetThreadId,
				callerName: caller.name,
				targetName: target.name,
				reused,
				deliveredMessageId: delivered.id,
			},
		};
	}

	/**
	 * Async hand-off: message the target agent and return immediately with its new
	 * thread id. The target processes independently; nothing is returned from its run.
	 */
	async sendMessage(input: DelegationInput): Promise<SendMessageResult> {
		const key = `${input.callerThreadId}→${input.targetAgentId}`;
		if (this.inFlight.has(key)) {
			return {
				ok: false,
				status: 409,
				error: 'A message to this agent is already being delivered. Wait for it to start before sending another.',
			};
		}
		this.inFlight.add(key);

		let prep: Awaited<ReturnType<typeof this.prepareDelegation>>;
		try {
			prep = await this.prepareDelegation(input);
		} catch (err) {
			this.inFlight.delete(key);
			throw err;
		}
		if (!prep.ok) {
			this.inFlight.delete(key);
			return prep;
		}
		const { targetThreadId, deliveredMessageId } = prep.prepared;

		// Fire-and-forget spawn. The in-flight lock is released only once the spawn
		// settles (the thread is 'running' by then), so a follow-up cannot double-spawn.
		// A declined/failed spawn rolls the delivered message back so a later retry
		// does not re-deliver it.
		this.runtimeService
			.spawnForThread(input.targetAgentId, targetThreadId, input.ownerId, 'agent')
			.then(async (spawned) => {
				if (!spawned) {
					logger.error(
						{ targetAgentId: input.targetAgentId, threadId: targetThreadId },
						'[a2a] target agent failed to start (send)',
					);
					await this.rollbackUndelivered(targetThreadId, deliveredMessageId);
				}
			})
			.catch(async (err: Error) => {
				logger.error(
					{ err, targetAgentId: input.targetAgentId, threadId: targetThreadId },
					'[a2a] target agent spawn threw (send)',
				);
				await this.rollbackUndelivered(targetThreadId, deliveredMessageId);
			})
			.finally(() => this.inFlight.delete(key));

		return {
			ok: true,
			threadId: targetThreadId,
			threadUrl: buildThreadUrl(input.targetAgentId, targetThreadId),
		};
	}

	/**
	 * Start an ask delegation: message the target agent, spawn it, and register a
	 * pending ask the sandbox polls via getAskResult(). Returns as soon as the spawn
	 * settles — the target's run outcome arrives through polling.
	 *
	 * `agent_delegation` events are emitted on the CALLER's thread ('started' here,
	 * 'completed'/'error' from the background completion waiter) so the chat UI can
	 * show a "waiting for «target»" indicator for the whole delegation.
	 */
	async startAsk(input: DelegationInput): Promise<StartAskResult> {
		const key = `${input.callerThreadId}→${input.targetAgentId}`;
		if (this.inFlight.has(key)) {
			return {
				ok: false,
				status: 409,
				error: 'A message to this agent is already being delivered. Wait for it to start before sending another.',
			};
		}
		this.inFlight.add(key);
		try {
			const prep = await this.prepareDelegation(input);
			if (!prep.ok) return prep;
			const { targetThreadId, targetName, deliveredMessageId } = prep.prepared;

			const emitDelegation = (state: 'started' | 'completed' | 'error') =>
				agentStreamBus.emit(input.callerThreadId, {
					type: 'agent_delegation',
					state,
					targetAgentId: input.targetAgentId,
					targetAgentName: targetName,
					targetThreadId,
				});

			const entry: PendingAsk = {
				callerAgentId: input.callerAgentId,
				callerThreadId: input.callerThreadId,
				deliveredMessageId,
				result: null,
			};
			this.pendingAsks.set(targetThreadId, entry);

			// Register the completion waiter BEFORE spawning so no terminal signal is
			// missed (spawnForThread settles waiters on every internal decline path).
			const completion = this.runtimeService.awaitThreadCompletion(targetThreadId, ASK_TIMEOUT_MS);

			// Background finalizer — settles the pollable result and emits the terminal
			// delegation event whenever the run (or the timeout) resolves the waiter.
			void completion.then(async (status) => {
				try {
					await this.finalizeAsk(entry, targetThreadId, status, emitDelegation);
				} catch (err) {
					logger.error({ err, threadId: targetThreadId }, '[a2a] ask finalization failed');
					entry.result = {
						status: 'error',
						error: 'The agent finished but its response could not be read.',
					};
					emitDelegation('error');
				}
				// Sweep the entry after a grace period so a dead caller cannot leak it.
				// Guarded by identity — a follow-up ask on the same (reused) thread will
				// have replaced the map entry, which this sweep must not remove.
				const sweep = setTimeout(() => {
					if (this.pendingAsks.get(targetThreadId) === entry) {
						this.pendingAsks.delete(targetThreadId);
					}
				}, ASK_RESULT_TTL_MS);
				sweep.unref();
			});

			emitDelegation('started');

			let spawned: boolean;
			try {
				spawned = await this.runtimeService.spawnForThread(
					input.targetAgentId,
					targetThreadId,
					input.ownerId,
					'agent',
				);
			} catch (err) {
				logger.error(
					{ err, targetAgentId: input.targetAgentId, threadId: targetThreadId },
					'[a2a] target agent spawn threw (ask)',
				);
				// spawnForThread's throw paths never settle waiters — release the
				// completion waiter now (the finalizer then emits 'error' and settles
				// the pollable result) instead of leaking it until the ask timeout.
				this.runtimeService.settleWaiters(targetThreadId, 'error');
				await this.rollbackUndelivered(targetThreadId, deliveredMessageId);
				return { ok: false, status: 500, error: 'Failed to start the target agent.' };
			}
			if (!spawned) {
				// Declined (cap, missing model, driver failure) — waiters are already
				// settled 'error' inside spawnForThread; the finalizer handles events.
				await this.rollbackUndelivered(targetThreadId, deliveredMessageId);
				return {
					ok: false,
					status: 503,
					error: 'The agent could not be started (it may be busy or misconfigured). Try again shortly.',
				};
			}

			return { ok: true, threadId: targetThreadId };
		} finally {
			// Safe to release: on success the thread is 'running' (set before
			// spawnForThread resolves), so the prepare-time status check now holds.
			this.inFlight.delete(key);
		}
	}

	/**
	 * Poll a pending ask. Only the initiating agent+thread (from the PROXY_TOKEN)
	 * may read it. 404 when unknown — expired, swept, or the backend restarted
	 * (pending asks are in-memory, like the runs they track).
	 */
	getAskResult(
		callerAgentId: string,
		callerThreadId: string,
		targetThreadId: string,
	): { ok: true; result: AgentAskPollResult } | { ok: false; status: number; error: string } {
		const entry = this.pendingAsks.get(targetThreadId);
		if (!entry || entry.callerAgentId !== callerAgentId || entry.callerThreadId !== callerThreadId) {
			return {
				ok: false,
				status: 404,
				error: 'No pending ask for this thread (it may have expired or the host restarted).',
			};
		}
		return { ok: true, result: entry.result ?? { status: 'running' } };
	}

	/** Compute and store the pollable outcome of a settled ask; emit the terminal event. */
	private async finalizeAsk(
		entry: PendingAsk,
		targetThreadId: string,
		status: AgentThreadStatus,
		emitDelegation: (state: 'completed' | 'error') => void,
	): Promise<void> {
		if (status !== 'completed') {
			logger.warn({ threadId: targetThreadId, status }, '[a2a] ask target did not complete');
			entry.result = {
				status: 'error',
				error:
					status === 'error'
						? 'The agent could not complete the request (it errored, was declined, or timed out).'
						: `The agent run ended without completing (status: ${status}).`,
			};
			emitDelegation('error');
			return;
		}

		const messages = await this.sessionService.listMessagesInternal(targetThreadId);
		// Only messages appended AFTER the delivered ask count — a reused delegation
		// thread contains earlier exchanges whose answers must not be returned as
		// this ask's response.
		const deliveredIdx = messages.findIndex((m) => m.id === entry.deliveredMessageId);
		const response = extractFinalAssistantText(
			deliveredIdx >= 0 ? messages.slice(deliveredIdx + 1) : messages,
		);
		if (!response) {
			entry.result = {
				status: 'error',
				error: 'The agent finished but produced no text response.',
			};
			emitDelegation('error');
			return;
		}
		entry.result = { status: 'completed', response, threadId: targetThreadId };
		emitDelegation('completed');
	}
}
