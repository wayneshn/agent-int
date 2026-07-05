<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { api } from '$lib/api.client.js';
	import { authStore } from '$lib/stores/auth.store.js';
	import { activeBreadcrumbThreadTitle } from '$lib/stores/breadcrumb.store.js';
	import { get } from 'svelte/store';
	import ChatThreadSidebar from '$lib/components/custom/chat/ChatThreadSidebar.svelte';
	import ChatMessage from '$lib/components/custom/chat/ChatMessage.svelte';
	import ChatInput from '$lib/components/custom/chat/ChatInput.svelte';
	import ChatUsageBar from '$lib/components/custom/chat/ChatUsageBar.svelte';
	import FilePreviewSidebar from '$lib/components/custom/chat/FilePreviewSidebar.svelte';
	import AgentAvatar from '$lib/components/custom/chat/AgentAvatar.svelte';
	import HitlPrompt from '$lib/components/custom/chat/HitlPrompt.svelte';
	import EditThreadTitleDialog from '$lib/components/custom/chat/EditThreadTitleDialog.svelte';
	import BrowserSessionDialog from '$lib/components/custom/chat/BrowserSessionDialog.svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte.js';
	import type { PageData } from './$types';
	import type {
		AgentMessage,
		AgentStreamEvent,
		AgentThread,
		AgentThreadStatus,
		ChatFile,
		ContentBlock
	} from '@repo/types';

	let { data }: { data: PageData } = $props();

	// ── State ─────────────────────────────────────────────────────────────────

	let messages = $state<AgentMessage[]>(data.messages);
	let threads = $state(data.threads);
	// Files attached to this thread (user uploads + agent-shared), grouped by message below.
	let threadFiles = $state<ChatFile[]>(data.threadFiles);
	// File preview sidebar state.
	let previewFile = $state<ChatFile | null>(null);
	let previewOpen = $state(false);
	let isStreaming = $state(false);
	/**
	 * Mirror of the persisted thread status from the backend (seeded on load,
	 * updated by SSE events and on stop). Combined with `isStreaming` it gates the
	 * Send/Stop button so a turn left stuck at 'running' (e.g. the runtime died
	 * before its exit handler ran) is still recoverable: the Stop button shows on
	 * reload even though no SSE is flowing.
	 */
	let threadStatus = $state<AgentThreadStatus>(data.thread.status);
	let isCreatingThread = $state(false);
	/** Mobile sidebar overlay open state */
	let sidebarOpen = $state(false);

	// ── Usage tracking (token/cost bar) ───────────────────────────────────────

	/**
	 * Current context window occupancy in tokens.
	 * Seeded from thread.contextTokens (a SET-style column on the thread row).
	 * On each message_end, SET to event.usage.input (the latest turn's input,
	 * which equals the full context the provider counted on that call).
	 * Unlike a running sum, this accurately reflects actual context size and can
	 * be reduced independently when a future compaction feature is implemented.
	 */
	let contextTokens = $state(data.threadContextTokens);

	/**
	 * Cumulative cost for this thread in USD.
	 * Seeded from DB (sum of all persisted assistant messages) and accumulated
	 * with each new message_end event so it stays consistent across page reloads.
	 */
	let sessionCost = $state(data.threadTotalCost);

	// ── History hydration helpers ──────────────────────────────────────────

	/**
	 * Build the toolResults map from persisted tool_result messages.
	 * Called on initial load and on thread navigation so the ToolCallIndicator
	 * shows results for historical messages after a page refresh.
	 */
	function buildToolResultsFromMessages(msgs: AgentMessage[]): Record<string, string> {
		const map: Record<string, string> = {};
		for (const msg of msgs) {
			if (msg.role !== 'tool_result' || !msg.toolCallId) continue;
			const text = msg.content
				.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
				.map((b) => {
					const MAX = 1000;
					return b.text.length > MAX ? b.text.slice(0, MAX) + '… [truncated]' : b.text;
				})
				.join('\n');
			map[msg.toolCallId] = text || '(no text output)';
		}
		return map;
	}

	/**
	 * Build the toolResultImages map from persisted tool_result messages, so image
	 * results (e.g. browser screenshots) render in the ToolCallIndicator after a
	 * reload — not just live via the tool_call_end SSE event.
	 */
	function buildToolResultImagesFromMessages(
		msgs: AgentMessage[]
	): Record<string, { data: string; mimeType: string }[]> {
		const map: Record<string, { data: string; mimeType: string }[]> = {};
		for (const msg of msgs) {
			if (msg.role !== 'tool_result' || !msg.toolCallId) continue;
			const images = msg.content
				.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
				.map((b) => ({ data: b.data, mimeType: b.mimeType }));
			if (images.length > 0) map[msg.toolCallId] = images;
		}
		return map;
	}

	/**
	 * Build the toolCallArgs map from assistant messages' toolCall content blocks.
	 * Called on initial load so the Arguments section shows for historical messages.
	 */
	function buildToolCallArgsFromMessages(
		msgs: AgentMessage[]
	): Record<string, { toolName: string; argsJson: string }> {
		const map: Record<string, { toolName: string; argsJson: string }> = {};
		for (const msg of msgs) {
			if (msg.role !== 'assistant') continue;
			for (const block of msg.content) {
				if (block.type !== 'toolCall') continue;
				if (Object.keys(block.arguments).length === 0) continue;
				map[block.id] = {
					toolName: block.name,
					argsJson: JSON.stringify(block.arguments, null, 2)
				};
			}
		}
		return map;
	}

	// ── Attachments ───────────────────────────────────────────────────────────

	/** Group thread files by the message they belong to (unlinked files excluded). */
	let attachmentsByMessageId = $derived.by(() => {
		const map: Record<string, ChatFile[]> = {};
		for (const file of threadFiles) {
			if (!file.messageId) continue;
			(map[file.messageId] ??= []).push(file);
		}
		return map;
	});

	/** Re-fetch the thread's file list (after a send links uploads to a message). */
	async function refreshFiles() {
		try {
			const res = await api(`/runtime/${data.agent.id}/threads/${data.thread.id}/files`);
			if (!res.ok) return;
			const body = await res.json();
			if (body.success) threadFiles = body.data as ChatFile[];
		} catch {
			// Non-fatal — the files will appear on the next reload.
		}
	}

	/** Open a file in the preview sidebar. */
	function openFile(file: ChatFile) {
		previewFile = file;
		previewOpen = true;
	}

	/**
	 * Re-sync all per-thread state when the active thread changes.
	 * SvelteKit re-uses this component across sibling thread routes, so `data`
	 * prop updates but $state vars keep their previous values without this effect.
	 */
	$effect(() => {
		// Reading data.thread.id establishes the reactive dependency.
		// Any navigation to a different thread triggers this block.
		const _ = data.thread.id;

		messages = data.messages;
		threads = data.threads;
		threadFiles = data.threadFiles;
		toolResults = buildToolResultsFromMessages(data.messages);
		toolResultImages = buildToolResultImagesFromMessages(data.messages);
		toolCallArgs = buildToolCallArgsFromMessages(data.messages);
		streamingUiCode = {};
		isStreaming = false;
		threadStatus = data.thread.status;
		streamingMessageId = null;
		optimisticAssistantId = null;
		clearOptimisticTimer();
		pendingHitl = null;
		// Reset session usage stats to the DB values for the new thread
		contextTokens = data.threadContextTokens;
		sessionCost = data.threadTotalCost;
		// Sync the breadcrumb title to the loaded thread title
		activeBreadcrumbThreadTitle.set(data.thread.title ?? null);

		// Start the new thread's stream from a clean connection state.
		pendingReconcile = false;
		staleSinceReconnect = false;

		// Re-open SSE for the new thread
		openStream();
		scrollToBottom();
	});

	/**
	 * In-progress streaming message — built up from SSE text_delta events
	 * and added to the messages list as a synthetic AgentMessage.
	 */
	let streamingMessageId = $state<string | null>(null);

	/**
	 * Id of the optimistic, empty assistant message that backs the typing indicator
	 * while the docker runtime spins up, before the real 'message_start' SSE event.
	 * It is inserted ~300ms after send (see optimisticTimer) so a fast response never
	 * flashes a redundant placeholder, upgraded in place to the real message on
	 * 'message_start', or removed if the turn ends without one. Null when none is
	 * outstanding.
	 */
	let optimisticAssistantId = $state<string | null>(null);

	/**
	 * Pending timer that inserts the optimistic placeholder a short delay after send.
	 * Cleared if the real stream starts (or the turn ends) within that window.
	 */
	let optimisticTimer: ReturnType<typeof setTimeout> | null = null;

	/** Delay before the artificial typing indicator appears, to avoid a fast-response flash. */
	const OPTIMISTIC_INDICATOR_DELAY_MS = 300;

	/** Cancel a pending optimistic-placeholder insertion, if any. */
	function clearOptimisticTimer() {
		if (optimisticTimer !== null) {
			clearTimeout(optimisticTimer);
			optimisticTimer = null;
		}
	}

	/**
	 * Map of toolCallId → result string.
	 * Seeded from DB tool_result messages on load; updated live by tool_call_end SSE events.
	 */
	let toolResults = $state<Record<string, string>>(buildToolResultsFromMessages(data.messages));

	/**
	 * Map of toolCallId → image content blocks (e.g. browser screenshots).
	 * Seeded from DB tool_result messages on load; updated live by tool_call_end SSE events.
	 */
	let toolResultImages = $state<Record<string, { data: string; mimeType: string }[]>>(
		buildToolResultImagesFromMessages(data.messages)
	);

	/**
	 * Map of toolCallId → { toolName, argsJson }.
	 * Seeded from assistant message toolCall blocks on load; updated live by tool_call_delta events.
	 */
	let toolCallArgs = $state<Record<string, { toolName: string; argsJson: string }>>(
		buildToolCallArgsFromMessages(data.messages)
	);

	/**
	 * Map of PLACEHOLDER toolCallId → render_ui code-so-far, fed by
	 * render_ui_partial snapshots so the generated UI renders progressively
	 * while the LLM is still writing it. Entries are dropped when the final
	 * tool_call_delta upgrades the block (complete args take over) and the
	 * whole map resets when the turn or thread changes.
	 */
	let streamingUiCode = $state<Record<string, string>>({});

	/**
	 * Pending HITL (Human-in-the-Loop) request from the agent.
	 * Set by the `hitl_request` SSE event; cleared when the user sends a reply.
	 * While set, the ChatInput is unlocked even though isStreaming=true.
	 */
	let pendingHitl = $state<{ prompt: string; options?: string[] } | null>(null);

	/**
	 * The agent is working this thread's turn — true while the live stream is
	 * active OR the persisted status is still 'running' (covers reload mid-turn
	 * and turns left stuck at 'running' after a runtime crash).
	 */
	let busy = $derived(isStreaming || threadStatus === 'running');

	/**
	 * Show the Stop button (instead of Send) whenever the agent is working and we
	 * are NOT waiting on a HITL reply — during HITL the input is for the human's
	 * response, so Send is correct there.
	 */
	let showStop = $derived(busy && pendingHitl === null);

	/**
	 * Chat input send path is disabled while busy UNLESS a HITL request is pending —
	 * in that case the human must be able to respond. This also blocks Enter-to-send
	 * while a turn is in flight or stuck (the Stop button is shown instead).
	 */
	let inputDisabled = $derived(busy && pendingHitl === null);

	/** Scroll anchor — kept at bottom of message list. */
	let scrollAnchor = $state<HTMLDivElement | undefined>(undefined);

	/** The current user's display name for avatar rendering. */
	let userDisplayName = $derived(
		(() => {
			const { user } = get(authStore);
			if (!user) return 'You';
			return user.first_name || user.last_name
				? [user.first_name, user.last_name].filter(Boolean).join(' ')
				: user.email.split('@')[0];
		})()
	);

	// ── SSE ───────────────────────────────────────────────────────────────────

	let eventSource: EventSource | null = null;

	/**
	 * Connection state for the live agent stream, surfaced to the user as a small
	 * "Reconnecting…" hint. The stream can silently drop (mobile network switch,
	 * laptop sleep, a proxy killing an idle socket) without EventSource noticing,
	 * so we don't rely on its built-in reconnect alone — see the watchdog below.
	 */
	let connectionState = $state<'connecting' | 'open' | 'reconnecting'>('connecting');

	/**
	 * Wall-clock (ms) of the last frame received — any agent event OR the server's
	 * `ping` heartbeat. The watchdog uses it to distinguish a live-but-quiet turn
	 * from a dead connection. Plain (non-reactive): only read inside the interval.
	 */
	let lastEventAt = 0;

	/** A reconnect is in progress; the next successful open should re-sync state. */
	let pendingReconcile = false;

	/**
	 * We reconnected while a bubble was rendering: defer the full transcript re-sync
	 * to the turn's end (the 'done' handler) so we don't wipe the in-progress bubble.
	 */
	let staleSinceReconnect = false;

	let watchdogTimer: ReturnType<typeof setInterval> | null = null;

	/** No frame (not even a ~15s heartbeat) for this long ⇒ force a reconnect. */
	const STALL_MS = 45_000;
	/** How often the watchdog checks for a stalled connection. */
	const WATCHDOG_INTERVAL_MS = 5_000;

	/**
	 * Open (or re-open) the SSE connection.
	 * EventSource cannot send custom headers, so the JWT is passed as a ?token= query param.
	 * The backend requireAuth middleware accepts it on GET requests.
	 *
	 * data.accessToken comes from the root +layout.server.ts
	 */
	function openStream() {
		if (!browser) return;
		closeStream();

		connectionState = pendingReconcile ? 'reconnecting' : 'connecting';
		lastEventAt = Date.now();

		const tokenParam = data.accessToken ? `?token=${encodeURIComponent(data.accessToken)}` : '';
		const url = `/api/v1/runtime/${data.agent.id}/threads/${data.thread.id}/stream${tokenParam}`;
		eventSource = new EventSource(url);

		eventSource.onopen = () => {
			connectionState = 'open';
			lastEventAt = Date.now();
			// If this open follows a drop, catch up on anything missed while away.
			if (pendingReconcile) {
				pendingReconcile = false;
				void reconcileAfterReconnect();
			}
		};

		eventSource.onmessage = (e: MessageEvent) => {
			lastEventAt = Date.now();
			if (!e.data || e.data === '') return;
			try {
				const event = JSON.parse(e.data) as AgentStreamEvent;
				handleStreamEvent(event);
			} catch {
				// ignore malformed frames
			}
		};

		// Observable heartbeat from the backend — keeps lastEventAt fresh so the
		// watchdog doesn't mistake a quiet (but alive) turn for a dead connection.
		eventSource.addEventListener('ping', () => {
			lastEventAt = Date.now();
		});

		eventSource.onerror = () => {
			// The socket dropped. EventSource will try to reconnect on its own, but we
			// don't trust that alone — mark reconnecting and request a catch-up on the
			// next open. Crucially, do NOT clear isStreaming here: the turn may still be
			// running on the backend, and giving up would strand the UI mid-turn.
			connectionState = 'reconnecting';
			pendingReconcile = true;
		};

		startWatchdog();
	}

	function closeStream() {
		stopWatchdog();
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
	}

	function startWatchdog() {
		stopWatchdog();
		watchdogTimer = setInterval(() => {
			if (!eventSource) return;
			// No frame (data or heartbeat) for too long ⇒ the connection is likely
			// half-open (the server side may already be gone, but EventSource never
			// noticed). Force a fresh reconnect and request a catch-up.
			if (Date.now() - lastEventAt > STALL_MS) {
				pendingReconcile = true;
				openStream();
			}
		}, WATCHDOG_INTERVAL_MS);
	}

	function stopWatchdog() {
		if (watchdogTimer) {
			clearInterval(watchdogTimer);
			watchdogTimer = null;
		}
	}

	/**
	 * After the stream re-opens following a drop, reconcile UI state with the
	 * backend. If a bubble is mid-render we defer the full re-sync to the turn's end
	 * (so we don't wipe the in-progress message); otherwise we re-fetch the persisted
	 * transcript so anything produced during the gap appears. A turn that finished
	 * while we were away is also unblocked by the backend, which emits a 'done' to
	 * every (re)connecting client whose thread is no longer 'running'.
	 */
	async function reconcileAfterReconnect() {
		// Title reconcile is independent of the message bubble — always attempt it.
		void reconcileThreadTitle();
		if (streamingMessageId !== null) {
			staleSinceReconnect = true;
			return;
		}
		await reconcileMessages();
	}

	/**
	 * The auto-generated title normally arrives via a `thread_title_updated` SSE
	 * event, but the bus has no replay — a missed event would leave the sidebar on
	 * "New conversation" until a manual reload. So while the active thread is still
	 * untitled, re-fetch the threads list (source of truth) and adopt any title that
	 * has since landed in the DB. No-op once a title exists.
	 */
	async function reconcileThreadTitle() {
		const current = threads.find((t) => t.id === data.thread.id);
		// 'New conversation' is the placeholder persisted on new threads — treat it as
		// untitled so the generated title still gets pulled in. Real titles stop here.
		if (current?.title && current.title !== 'New conversation') return;
		try {
			const res = await api(`/runtime/${data.agent.id}/threads`);
			if (!res.ok) return;
			const body = await res.json();
			const serverThreads = (body.data ?? []) as typeof threads;
			const fresh = serverThreads.find((t) => t.id === data.thread.id);
			if (fresh?.title) {
				threads = threads.map((t) => (t.id === fresh.id ? { ...t, title: fresh.title } : t));
				if (fresh.id === data.thread.id) {
					activeBreadcrumbThreadTitle.set(fresh.title);
				}
			}
		} catch {
			// Non-fatal — the next turn end / reconnect retries.
		}
	}

	/** Re-fetch the persisted transcript and rebuild the derived tool maps. */
	async function reconcileMessages() {
		try {
			const res = await api(`/runtime/${data.agent.id}/threads/${data.thread.id}/messages`);
			if (!res.ok) return;
			const body = await res.json();
			const serverMessages = (body.data ?? []) as AgentMessage[];
			messages = serverMessages;
			toolResults = buildToolResultsFromMessages(serverMessages);
			toolResultImages = buildToolResultImagesFromMessages(serverMessages);
			toolCallArgs = buildToolCallArgsFromMessages(serverMessages);
			streamingMessageId = null;
			optimisticAssistantId = null;
			clearOptimisticTimer();
			scrollToBottom();
		} catch {
			// Non-fatal: the live stream and the next reconnect will resync.
		}
	}

	/** Process a single SSE event and update UI state accordingly. */
	function handleStreamEvent(event: AgentStreamEvent) {
		switch (event.type) {
			case 'message_start': {
				// The real stream started — cancel any not-yet-fired artificial indicator.
				clearOptimisticTimer();
				streamingMessageId = event.messageId;
				// If an optimistic placeholder is already on screen (first message of the
				// turn), upgrade it in place to the real id — no flicker, no duplicate
				// bubble. Otherwise (e.g. a second assistant message after a tool call),
				// append a fresh empty placeholder as before.
				if (optimisticAssistantId) {
					const placeholderId = optimisticAssistantId;
					optimisticAssistantId = null;
					messages = messages.map((m) =>
						m.id === placeholderId ? { ...m, id: event.messageId } : m
					);
				} else {
					const placeholder: AgentMessage = {
						id: event.messageId,
						threadId: data.thread.id,
						role: 'assistant',
						content: [],
						createdAt: new Date()
					};
					messages = [...messages, placeholder];
				}
				isStreaming = true;
				threadStatus = 'running';
				scrollToBottom();
				break;
			}

			case 'text_delta': {
				// Append text delta to the streaming message's first text block
				messages = messages.map((msg) => {
					if (msg.id !== event.messageId) return msg;
					const blocks = [...msg.content];
					const lastText = blocks.findLastIndex((b) => b.type === 'text');
					if (lastText >= 0) {
						const updated = blocks[lastText] as Extract<ContentBlock, { type: 'text' }>;
						blocks[lastText] = { type: 'text', text: updated.text + event.delta };
					} else {
						blocks.push({ type: 'text', text: event.delta });
					}
					return { ...msg, content: blocks };
				});
				scrollToBottom();
				break;
			}

			case 'thinking_delta': {
				messages = messages.map((msg) => {
					if (msg.id !== event.messageId) return msg;
					const blocks = [...msg.content];
					const lastThinking = blocks.findLastIndex((b) => b.type === 'thinking');
					if (lastThinking >= 0) {
						const updated = blocks[lastThinking] as Extract<ContentBlock, { type: 'thinking' }>;
						blocks[lastThinking] = {
							type: 'thinking',
							thinking: updated.thinking + event.delta
						};
					} else {
						blocks.push({ type: 'thinking', thinking: event.delta });
					}
					return { ...msg, content: blocks };
				});
				break;
			}

			case 'tool_call_start': {
				// Add a placeholder toolCall block using the temporary contentIndex-based id.
				// The real toolCallId and toolName arrive in the subsequent tool_call_delta event.
				messages = messages.map((msg) => {
					if (msg.id !== event.messageId) return msg;
					const newBlock: ContentBlock = {
						type: 'toolCall',
						id: event.toolCallId,
						name: event.toolName,
						arguments: {}
					};
					return { ...msg, content: [...msg.content, newBlock] };
				});
				break;
			}

			case 'render_ui_partial': {
				// Cumulative snapshot of the render_ui code while the LLM writes it —
				// keyed by the placeholder id so ChatMessage can stream-render the UI.
				streamingUiCode = { ...streamingUiCode, [event.toolCallId]: event.code };
				break;
			}

			case 'tool_call_delta': {
				// Replace the placeholder block (keyed by placeholderId) with the real
				// toolCallId and toolName now that the LLM has finished forming the call.
				// Also store args so ToolCallIndicator can show the "thinking context".
				messages = messages.map((msg) => {
					if (msg.id !== event.messageId) return msg;
					const blocks = msg.content.map((b) => {
						if (b.type !== 'toolCall' || b.id !== event.placeholderId) return b;
						return {
							type: 'toolCall' as const,
							id: event.toolCallId,
							name: event.toolName,
							arguments: {}
						};
					});
					return { ...msg, content: blocks };
				});
				toolCallArgs = {
					...toolCallArgs,
					[event.toolCallId]: { toolName: event.toolName, argsJson: event.argsJson }
				};
				// The block id just changed — drop the streaming snapshot; the complete
				// args now render via the normal path.
				if (event.placeholderId in streamingUiCode) {
					const { [event.placeholderId]: _dropped, ...rest } = streamingUiCode;
					streamingUiCode = rest;
				}
				break;
			}

			case 'tool_call_end': {
				// Store the execution result for the tool indicator to display
				toolResults = { ...toolResults, [event.toolCallId]: event.result };
				// Store any image blocks (e.g. a browser screenshot) so they render live
				if (event.images && event.images.length > 0) {
					toolResultImages = { ...toolResultImages, [event.toolCallId]: event.images };
				}
				break;
			}

			case 'file_shared': {
				// Agent shared a file — render it under the agent's bubble. Live, the
				// streaming assistant message uses an SSE id that differs from the DB
				// messageId the backend linked the file to, so re-point it at the most
				// recent assistant message in the UI. On reload both sides use DB ids.
				const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
				const sharedFile = lastAssistant
					? { ...event.file, messageId: lastAssistant.id }
					: event.file;
				// De-dupe in case of a reconnect replay.
				if (!threadFiles.some((f) => f.id === sharedFile.id)) {
					threadFiles = [...threadFiles, sharedFile];
				}
				scrollToBottom();
				break;
			}

			case 'message_end': {
				messages = messages.map((msg) => {
					if (msg.id !== event.messageId) return msg;
					return { ...msg, tokenUsage: event.usage };
				});
				if (event.usage) {
					// Accumulate context tokens: add both input and output for this turn.
					// Output tokens from this turn become input context on the next turn,
					// so both contribute to growing context size. A future compaction
					// feature will reset this value independently of sessionCost.
					contextTokens += event.usage.input + event.usage.output;
					// Cost is also cumulative.
					sessionCost += event.usage.cost.total;
				}
				streamingMessageId = null;
				isStreaming = false;
				scrollToBottom();
				break;
			}

			case 'hitl_request': {
				// Agent is pausing and waiting for a human response.
				// Store the prompt so HitlPrompt renders in the message list.
				// inputDisabled will automatically unlock because pendingHitl is non-null.
				pendingHitl = { prompt: event.prompt, options: event.options };
				scrollToBottom();
				break;
			}

			case 'thread_title_updated': {
				// Update the title of the active thread in the sidebar immediately.
				threads = threads.map((t) => (t.id === event.threadId ? { ...t, title: event.title } : t));
				// Also update the breadcrumb if this is the currently viewed thread
				if (event.threadId === data.thread.id) {
					activeBreadcrumbThreadTitle.set(event.title);
				}
				break;
			}

			case 'done': {
				isStreaming = false;
				// Clear any stale 'running' so the button reverts to Send (the row is
				// 'completed'/'error' in the DB; 'idle' here just means "not running").
				if (threadStatus === 'running') threadStatus = 'idle';
				streamingMessageId = null;
				streamingUiCode = {};
				// Clear any lingering HITL state (e.g. if the tool timed out)
				pendingHitl = null;
				clearOptimisticTimer();
				// Drop a never-upgraded optimistic placeholder so the turn doesn't end
				// with a stale empty assistant bubble (e.g. runtime never started).
				if (optimisticAssistantId) {
					const placeholderId = optimisticAssistantId;
					optimisticAssistantId = null;
					messages = messages.filter((m) => m.id !== placeholderId);
				}
				// If we reconnected mid-turn, the in-progress bubble may be incomplete —
				// now that the turn has ended, pull the persisted transcript to be sure.
				if (staleSinceReconnect) {
					staleSinceReconnect = false;
					void reconcileMessages();
				}
				// The auto-title is generated in the background during the turn; by the
				// time it ends it's persisted, so pull it in case the SSE event was missed.
				void reconcileThreadTitle();
				break;
			}

			case 'error': {
				isStreaming = false;
				threadStatus = 'error';
				streamingMessageId = null;
				streamingUiCode = {};
				pendingHitl = null;
				clearOptimisticTimer();
				// Replace any never-upgraded optimistic placeholder with the error
				// message rather than leaving an empty bubble beside it.
				if (optimisticAssistantId) {
					const placeholderId = optimisticAssistantId;
					optimisticAssistantId = null;
					messages = messages.filter((m) => m.id !== placeholderId);
				}
				// Show the error as a toast so it's hard to miss
				setAlert({
					type: 'error',
					title: 'Agent error',
					message: event.message,
					duration: 8000,
					show: true
				});
				const errorMsg: AgentMessage = {
					id: `error-${Date.now()}`,
					threadId: data.thread.id,
					role: 'assistant',
					content: [{ type: 'text', text: `⚠️ ${event.message}` }],
					createdAt: new Date()
				};
				messages = [...messages, errorMsg];
				scrollToBottom();
				break;
			}
		}
	}

	// ── Messaging ─────────────────────────────────────────────────────────────

	async function handleSend(content: string, fileIds: string[] = []) {
		// Allow sending when a HITL is pending even though the turn is in flight.
		// In all other busy states (streaming, or stuck at 'running') the input is locked.
		if (busy && pendingHitl === null) return;

		// Clear the HITL prompt immediately so the UI doesn't show a stale card
		// while the response is in flight.
		if (pendingHitl !== null) {
			pendingHitl = null;
		}

		// Optimistically add the user message immediately.
		const optimisticMsg: AgentMessage = {
			id: `optimistic-${Date.now()}`,
			threadId: data.thread.id,
			role: 'user',
			content: [{ type: 'text', text: content }],
			createdAt: new Date()
		};
		messages = [...messages, optimisticMsg];
		scrollToBottom();

		isStreaming = true;

		// Show an artificial typing indicator after a short delay — an empty assistant
		// placeholder that satisfies (isStreaming && assistant && no text yet). This
		// bridges the docker runtime spin-up gap before the real 'message_start' SSE
		// event. The delay avoids flashing it when the response starts quickly; if
		// 'message_start' arrives first it clears this timer and creates the bubble itself.
		const placeholderId = `optimistic-assistant-${Date.now()}`;
		clearOptimisticTimer();
		optimisticTimer = setTimeout(() => {
			optimisticTimer = null;
			// The real stream already started this turn — nothing to do.
			if (streamingMessageId !== null) return;
			const optimisticAssistant: AgentMessage = {
				id: placeholderId,
				threadId: data.thread.id,
				role: 'assistant',
				content: [],
				createdAt: new Date()
			};
			optimisticAssistantId = placeholderId;
			// Point streamingMessageId at the placeholder so the per-message
			// `isStreaming && id === streamingMessageId` binding lights up its typing
			// indicator; 'message_start' reassigns it to the real id.
			streamingMessageId = placeholderId;
			messages = [...messages, optimisticAssistant];
			scrollToBottom();
		}, OPTIMISTIC_INDICATOR_DELAY_MS);

		try {
			const res = await api(`/runtime/${data.agent.id}/threads/${data.thread.id}/messages`, {
				method: 'POST',
				// Include the browser's local datetime with timezone offset so the agent system
				// prompt reflects the user's local time, not UTC.
				body: JSON.stringify({ content, userDatetime: new Date().toString(), fileIds })
			});

			if (!res.ok) {
				// Cancel the pending indicator and remove the optimistic user message
				// (and the placeholder, if it was already inserted) on failure.
				clearOptimisticTimer();
				messages = messages.filter((m) => m.id !== optimisticMsg.id && m.id !== placeholderId);
				optimisticAssistantId = null;
				streamingMessageId = null;
				const body = await res.json();
				setAlert({
					type: 'error',
					title: 'Failed to send',
					message: body.error ?? 'Could not send message.',
					duration: 5000,
					show: true
				});
				isStreaming = false;
				return;
			}

			// Replace optimistic message with the real one from the API
			const body = await res.json();
			const realMsg = body.data as AgentMessage;
			messages = messages.map((m) => (m.id === optimisticMsg.id ? realMsg : m));
			// Refresh the file list so uploaded attachments (now linked to the real
			// message id) render under the message.
			if (fileIds.length > 0) void refreshFiles();
		} catch {
			clearOptimisticTimer();
			messages = messages.filter((m) => m.id !== optimisticMsg.id && m.id !== placeholderId);
			optimisticAssistantId = null;
			streamingMessageId = null;
			setAlert({
				type: 'error',
				title: 'Failed to send',
				message: 'An unexpected error occurred.',
				duration: 5000,
				show: true
			});
			isStreaming = false;
		}
		// isStreaming is set back to false by the 'done' or 'message_end' SSE event
	}

	/**
	 * Stop the current (or stuck) turn. Calls the backend cancel endpoint, which
	 * kills the live runtime if one exists (otherwise just reconciles an orphaned
	 * 'running' row) and returns the thread at 'idle' so the user can send again.
	 * The backend also emits a 'done' SSE, so the SSE handler cleans up redundantly.
	 */
	async function handleStop() {
		try {
			const res = await api(`/runtime/${data.agent.id}/threads/${data.thread.id}/cancel`, {
				method: 'POST'
			});
			if (!res.ok) {
				const body = await res.json();
				setAlert({
					type: 'error',
					title: 'Failed to stop',
					message: body.error ?? 'Could not stop the agent.',
					duration: 5000,
					show: true
				});
				return;
			}
			const body = await res.json();
			const updated = body.data as AgentThread;
			threadStatus = updated.status;
			// Keep the sidebar running-dot in sync with the now-idle thread.
			threads = threads.map((t) => (t.id === updated.id ? { ...t, status: updated.status } : t));
			isStreaming = false;
			streamingMessageId = null;
			pendingHitl = null;
			clearOptimisticTimer();
			// Drop a never-upgraded optimistic placeholder so we don't leave an empty bubble.
			if (optimisticAssistantId) {
				const placeholderId = optimisticAssistantId;
				optimisticAssistantId = null;
				messages = messages.filter((m) => m.id !== placeholderId);
			}
		} catch {
			setAlert({
				type: 'error',
				title: 'Failed to stop',
				message: 'An unexpected error occurred.',
				duration: 5000,
				show: true
			});
		}
	}

	/** Create a new thread and navigate to it. */
	async function handleNewChat() {
		isCreatingThread = true;
		try {
			const res = await api(`/runtime/${data.agent.id}/threads`, {
				method: 'POST',
				body: JSON.stringify({ title: 'New conversation' })
			});
			if (!res.ok) {
				setAlert({
					type: 'error',
					title: 'Failed to start chat',
					message: 'Could not create a new conversation.',
					duration: 5000,
					show: true
				});
				return;
			}
			const body = await res.json();
			// Navigate using SvelteKit's client-side router to avoid a full page reload
			// (which would cause a dark-mode flash before the theme script in app.html fires).
			await goto(`/app/chat/${data.agent.id}/${body.data.id}`);
		} catch {
			setAlert({
				type: 'error',
				title: 'Failed to start chat',
				message: 'An unexpected error occurred.',
				duration: 5000,
				show: true
			});
		} finally {
			isCreatingThread = false;
		}
	}

	// ── Scroll ────────────────────────────────────────────────────────────────

	function scrollToBottom() {
		// Use rAF to wait for DOM update before scrolling
		requestAnimationFrame(() => {
			scrollAnchor?.scrollIntoView({ behavior: 'smooth', block: 'end' });
		});
	}

	// ── Thread management ─────────────────────────────────────────────────────

	/** Thread targeted by the rename/delete UI — set when user clicks a menu item. */
	let renameTarget = $state<AgentThread | null>(null);
	let renameDialogOpen = $state(false);
	let isSavingRename = $state(false);

	let deleteTarget = $state<AgentThread | null>(null);
	let deleteDialogOpen = $state(false);
	let isDeleting = $state(false);

	let browserDialogOpen = $state(false);
	let browserThreadTarget = $state<AgentThread | null>(null);

	/** Open the browser-session management modal for the given thread. */
	function handleBrowserSession(thread: AgentThread) {
		browserThreadTarget = thread;
		browserDialogOpen = true;
	}

	/** Open the rename dialog pre-populated with the thread's current title. */
	function handleRenameThread(thread: AgentThread) {
		renameTarget = thread;
		renameDialogOpen = true;
	}

	/** Open the delete confirmation dialog for a thread. */
	function handleDeleteThread(thread: AgentThread) {
		deleteTarget = thread;
		deleteDialogOpen = true;
	}

	/** Save a new title for the targeted thread via PATCH. */
	async function handleSaveTitle(title: string) {
		if (!renameTarget) return;
		isSavingRename = true;
		try {
			const res = await api(`/runtime/${data.agent.id}/threads/${renameTarget.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ title })
			});
			if (!res.ok) {
				const body = await res.json();
				setAlert({
					type: 'error',
					title: 'Failed to rename',
					message: body.error ?? 'Could not rename the conversation.',
					duration: 5000,
					show: true
				});
				return;
			}
			// Optimistically update the thread title in the sidebar
			threads = threads.map((t) => (t.id === renameTarget!.id ? { ...t, title } : t));
			// If renaming the currently active thread, update the breadcrumb immediately
			if (renameTarget!.id === data.thread.id) {
				activeBreadcrumbThreadTitle.set(title);
			}
			renameDialogOpen = false;
		} catch {
			setAlert({
				type: 'error',
				title: 'Failed to rename',
				message: 'An unexpected error occurred.',
				duration: 5000,
				show: true
			});
		} finally {
			isSavingRename = false;
		}
	}

	/** Delete the targeted thread via DELETE, then navigate away if it was active. */
	async function handleConfirmDelete() {
		if (!deleteTarget) return;
		isDeleting = true;
		const wasActive = deleteTarget.id === data.thread.id;
		try {
			const res = await api(`/runtime/${data.agent.id}/threads/${deleteTarget.id}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				const body = await res.json();
				setAlert({
					type: 'error',
					title: 'Failed to delete',
					message: body.error ?? 'Could not delete the conversation.',
					duration: 5000,
					show: true
				});
				return;
			}
			threads = threads.filter((t) => t.id !== deleteTarget!.id);
			deleteDialogOpen = false;
			if (wasActive) {
				// Navigate to the next available thread or back to the agent page
				const next = threads[0];
				goto(next ? `/app/chat/${data.agent.id}/${next.id}` : `/app/chat/${data.agent.id}`);
			}
		} catch {
			setAlert({
				type: 'error',
				title: 'Failed to delete',
				message: 'An unexpected error occurred.',
				duration: 5000,
				show: true
			});
		} finally {
			isDeleting = false;
		}
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	onDestroy(() => {
		closeStream();
		clearOptimisticTimer();
	});
</script>

<svelte:head>
	<title>{data.agent.name} — Chat — Valmis</title>
	<meta name="description" content="Chatting with {data.agent.name} on Valmis." />
</svelte:head>

<div class="flex h-full overflow-hidden">
	<!-- Sidebar — bind:threads allows the sidebar to optimistically update pin state -->
	<ChatThreadSidebar
		agent={data.agent}
		bind:threads
		activeThreadId={data.thread.id}
		{isCreatingThread}
		bind:open={sidebarOpen}
		browserAvailable={data.browserAvailable}
		onNewChat={handleNewChat}
		onRenameThread={handleRenameThread}
		onDeleteThread={handleDeleteThread}
		onBrowserSession={handleBrowserSession}
	/>

	<!-- Right panel: chat area -->
	<div class="relative flex min-w-0 flex-1 flex-col bg-background">
		<!-- Message list (scrollable) -->
		<ScrollArea class="flex-1 overflow-hidden">
			{#if messages.length === 0}
				<!-- Empty thread welcome -->
				<div class="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
					<AgentAvatar avatarUrl={data.agent.avatarUrl} name={data.agent.name} size="lg" />
					<div>
						<h2 class="text-base font-semibold text-foreground">{data.agent.name}</h2>
						<p class="mt-1 text-sm text-muted-foreground">
							{data.agent.description ?? 'How can I help you today?'}
						</p>
					</div>
				</div>
			{:else}
				<!-- Wide content area with generous side padding -->
				<div class="mx-auto w-full max-w-4xl py-6 md:px-8">
					{#each messages as message (message.id)}
						<ChatMessage
							{message}
							agentName={data.agent.name}
							agentAvatarUrl={data.agent.avatarUrl}
							{userDisplayName}
							isStreaming={isStreaming && message.id === streamingMessageId}
							{toolResults}
							{toolResultImages}
							{toolCallArgs}
							{streamingUiCode}
							credentialMetaMap={data.credentialMetaMap}
							attachments={attachmentsByMessageId[message.id] ?? []}
							agentId={data.agent.id}
							threadId={data.thread.id}
							onOpenFile={openFile}
							onUiAction={(text) => handleSend(text)}
						/>
					{/each}

					<!-- HITL prompt — shown when agent is waiting for human input -->
					{#if pendingHitl}
						<HitlPrompt
							prompt={pendingHitl.prompt}
							options={pendingHitl.options}
							onSelectOption={(option) => handleSend(option)}
						/>
					{/if}

					<!-- Scroll anchor -->
					<div bind:this={scrollAnchor} class="h-4"></div>
				</div>
			{/if}
		</ScrollArea>

		<!-- Token/cost bar + input -->
		<div class="mx-auto w-full max-w-4xl md:px-8">
			<!-- Live-stream connection hint — shown while the SSE link is recovering -->
			{#if connectionState === 'reconnecting'}
				<div
					class="flex items-center justify-center gap-2 px-4 pb-1 text-[11px] text-muted-foreground"
					role="status"
				>
					<span class="size-1.5 animate-pulse rounded-full bg-amber-500"></span>
					Reconnecting to the agent…
				</div>
			{/if}
			<!-- Subtle usage bar shown above the input; togglable via the eye icon -->
			<ChatUsageBar
				latestInputTokens={contextTokens}
				{sessionCost}
				modelContextLength={data.modelContextLength}
			/>
			<ChatInput
				onSend={handleSend}
				onStop={handleStop}
				busy={showStop}
				disabled={inputDisabled}
				placeholder={pendingHitl ? 'Type your response…' : `Message ${data.agent.name}…`}
				agentId={data.agent.id}
				threadId={data.thread.id}
				visionCapable={data.visionCapable}
			/>
		</div>
	</div>
</div>

<!-- Rename thread dialog -->
<EditThreadTitleDialog
	bind:open={renameDialogOpen}
	currentTitle={renameTarget?.title ?? ''}
	isSaving={isSavingRename}
	onSave={handleSaveTitle}
/>

<!-- Browser session management modal -->
<BrowserSessionDialog
	bind:open={browserDialogOpen}
	agentId={data.agent.id}
	agentName={data.agent.name}
	threadId={browserThreadTarget?.id}
/>

<!-- File preview / download sidebar -->
<FilePreviewSidebar
	bind:open={previewOpen}
	file={previewFile}
	agentId={data.agent.id}
	threadId={data.thread.id}
/>

<!-- Delete thread confirmation dialog -->
<Dialog.Root bind:open={deleteDialogOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Delete conversation</Dialog.Title>
			<Dialog.Description>
				This will permanently delete "<strong>{deleteTarget?.title ?? 'this conversation'}</strong>"
				and all its messages. This action cannot be undone.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer class="gap-2">
			<Button variant="outline" onclick={() => (deleteDialogOpen = false)} disabled={isDeleting}>
				Cancel
			</Button>
			<Button variant="destructive" onclick={handleConfirmDelete} disabled={isDeleting}>
				{isDeleting ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
