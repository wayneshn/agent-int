<script lang="ts">
	import AgentAvatar from './AgentAvatar.svelte';
	import UserAvatar from './UserAvatar.svelte';
	import ThinkingBlock from './ThinkingBlock.svelte';
	import ToolCallIndicator from './ToolCallIndicator.svelte';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import ImageBlock from './ImageBlock.svelte';
	import ChatAttachment from './ChatAttachment.svelte';
	import OpenUiBlock from './OpenUiBlock.svelte';
	import { TOOL_ICON_MAP, DEFAULT_TOOL_ICON } from './tool-icon-map.js';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import ClipboardListIcon from '@lucide/svelte/icons/clipboard-list';
	import type { AgentMessage, ChatFile, ContentBlock } from '@repo/types';

	/** Shape of one entry in credentialMetaMap */
	interface CredentialMeta {
		icon: string | undefined;
		integrationName: string;
	}

	/**
	 * Renders a single chat message row.
	 * Handles user, assistant, and tool_result roles.
	 * Supports streaming (partially built text content).
	 */
	let {
		message,
		agentName,
		agentAvatarUrl,
		userDisplayName,
		isStreaming = false,
		/** Map of toolCallId → result string, for matching tool_result back to toolCall */
		toolResults = {},
		/** Map of toolCallId → image content blocks (e.g. browser screenshots) */
		toolResultImages = {},
		/**
		 * Map of toolCallId → { toolName, argsJson }.
		 * Populated by tool_call_delta SSE events so ToolCallIndicator can show
		 * the arguments the LLM decided to pass (the "thinking context").
		 */
		toolCallArgs = {},
		/**
		 * Map of credentialId → { icon, integrationName }.
		 * icon: logo path from the YAML definition (e.g. /logos/github.svg), may be undefined.
		 * integrationName: human-readable name (e.g. "GitHub", "Slack").
		 * Used to display the integration icon and name in call_api tool indicators.
		 */
		credentialMetaMap = {},
		/** Chat files attached to this message (user uploads + agent-shared files). */
		attachments = [],
		/** Agent + thread ids — needed to fetch attachment bytes via the api client. */
		agentId,
		threadId,
		/** Open a file in the preview sidebar. */
		onOpenFile,
		/**
		 * Send a chat message on behalf of the user — fired by interactive UI
		 * (render_ui button clicks / form submits). Absent on read-only contexts.
		 */
		onUiAction,
		/**
		 * Map of PLACEHOLDER toolCallId → render_ui code-so-far. Fed by
		 * render_ui_partial SSE snapshots so the UI renders progressively while
		 * the LLM is still writing it; empty once the tool call completes.
		 */
		streamingUiCode = {}
	}: {
		message: AgentMessage;
		agentName: string;
		agentAvatarUrl?: string;
		userDisplayName: string;
		isStreaming?: boolean;
		toolResults?: Record<string, string>;
		toolResultImages?: Record<string, { data: string; mimeType: string }[]>;
		toolCallArgs?: Record<string, { toolName: string; argsJson: string }>;
		credentialMetaMap?: Record<string, CredentialMeta>;
		attachments?: ChatFile[];
		agentId: string;
		threadId: string;
		onOpenFile: (file: ChatFile) => void;
		onUiAction?: (text: string) => void;
		streamingUiCode?: Record<string, string>;
	} = $props();

	let isUser = $derived(message.role === 'user');
	let isAssistant = $derived(message.role === 'assistant');

	/** Extract text blocks from content for rendering */
	let textBlocks = $derived(
		message.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
	);

	let thinkingBlocks = $derived(
		message.content.filter(
			(b): b is Extract<ContentBlock, { type: 'thinking' }> => b.type === 'thinking'
		)
	);

	let toolCallBlocks = $derived(
		message.content.filter(
			(b): b is Extract<ContentBlock, { type: 'toolCall' }> => b.type === 'toolCall'
		)
	);

	let imageBlocks = $derived(
		message.content.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
	);

	/** Combined text across all text blocks for display. */
	let combinedText = $derived(textBlocks.map((b) => b.text).join('\n\n'));

	/** Messages carrying generated UI get the full column width (charts, tables). */
	let hasUiBlock = $derived(toolCallBlocks.some((b) => b.name === 'render_ui'));

	/** Show a loading pulse if streaming and no text yet */
	let showTypingIndicator = $derived(isStreaming && isAssistant && combinedText.length === 0);

	/**
	 * Resolve the icon and label to display for a tool call.
	 *
	 * For call_api with a credentialId present in credentialMetaMap:
	 *   → returns integration logo URL + integration name for the label.
	 *
	 * For read_file on a path inside skills/<name>/ (progressive disclosure —
	 * the agent reading a skill's instructions counts as using that skill):
	 *   → returns SparklesIcon + "Using skill — <name>" for the label.
	 *
	 * For all other tools (or call_api with no/unknown credential):
	 *   → returns a Lucide icon component from TOOL_ICON_MAP (fallback: DEFAULT_TOOL_ICON).
	 *   → toolDisplayName is undefined so ToolCallIndicator uses its default snake_case formatter.
	 */
	function resolveToolDisplay(
		toolName: string,
		argsJson: string | undefined
	):
		| { type: 'img'; url: string; toolDisplayName: string }
		| { type: 'icon'; component: typeof DEFAULT_TOOL_ICON; toolDisplayName?: string } {
		if (toolName === 'call_api' && argsJson) {
			try {
				const args = JSON.parse(argsJson) as Record<string, unknown>;
				const credentialId = typeof args.credentialId === 'string' ? args.credentialId : '';
				if (credentialId) {
					const meta = credentialMetaMap[credentialId];
					if (meta?.icon) {
						return {
							type: 'img',
							url: meta.icon,
							toolDisplayName: `Call Api — ${meta.integrationName}`
						};
					}
				}
			} catch {
				// malformed argsJson — fall through to icon
			}
		}
		if (toolName === 'read_file' && argsJson) {
			try {
				const args = JSON.parse(argsJson) as Record<string, unknown>;
				const path = typeof args.path === 'string' ? args.path : '';
				// Any file under skills/<name>/ counts — same rule as the backend's
				// skill activation detection (detectSkillRead in the agent runtime).
				const skillMatch = path.match(/^skills\/([^/]+)\//);
				if (skillMatch) {
					return {
						type: 'icon',
						component: SparklesIcon,
						toolDisplayName: `Using skill — ${skillMatch[1]}`
					};
				}
			} catch {
				// malformed argsJson — fall through to icon
			}
		}
		return { type: 'icon', component: TOOL_ICON_MAP[toolName] ?? DEFAULT_TOOL_ICON };
	}

	/**
	 * Extract the OpenUI Lang source of a render_ui tool call. Historical
	 * messages carry it in block.arguments (from DB); live streaming carries it
	 * in the tool_call_delta argsJson. Undefined while args haven't arrived yet.
	 */
	function extractUiCode(
		argsJson: string | undefined,
		blockArgs: Record<string, unknown>
	): string | undefined {
		if (typeof blockArgs.code === 'string' && blockArgs.code.length > 0) {
			return blockArgs.code;
		}
		if (argsJson) {
			try {
				const parsed = JSON.parse(argsJson) as Record<string, unknown>;
				if (typeof parsed.code === 'string' && parsed.code.length > 0) {
					return parsed.code;
				}
			} catch {
				// malformed argsJson — treat as not yet available
			}
		}
		return undefined;
	}

	/**
	 * Detect a UI form-submission message. OpenUiBlock sends interactions as
	 * "<label>\n\n```json\n<data>\n```" (the JSON is the agent-facing payload);
	 * for display we show the label in the bubble and the data in an expandable
	 * ToolCallIndicator instead of raw code fences. Returns null for ordinary
	 * text or when the trailing block isn't valid JSON (conservative fallback
	 * to plain rendering). Keep in sync with OpenUiBlock.handleAction.
	 */
	function parseUserFormMessage(text: string): { label: string; json: string } | null {
		const match = text.match(/^([\s\S]*?)\n\n```json\n([\s\S]*?)\n```\s*$/);
		if (!match) return null;
		try {
			JSON.parse(match[2]);
		} catch {
			return null;
		}
		return { label: match[1].trim(), json: match[2] };
	}

	let userFormMessage = $derived(isUser ? parseUserFormMessage(combinedText) : null);
</script>

{#if message.role === 'tool_result'}
	<!-- Tool result messages are not shown directly; they are surfaced via ToolCallIndicator -->
{:else}
	<div class="group flex gap-3 px-4 py-3 {isUser ? 'flex-row-reverse' : 'flex-row'}">
		<!-- Avatar -->
		<div class="mt-0.5 shrink-0">
			{#if isUser}
				<UserAvatar displayName={userDisplayName} size="md" />
			{:else}
				<AgentAvatar avatarUrl={agentAvatarUrl} name={agentName} size="md" />
			{/if}
		</div>

		<!-- Message content: max-w-[75%] caps width; min-w-0 + overflow-hidden prevents flex blowout
		 on mobile. Assistant messages with generated UI (render_ui) take the full column width. -->
		<div
			class="flex min-w-0 flex-col gap-1 overflow-hidden px-1 {isAssistant && hasUiBlock
				? 'w-full max-w-full'
				: 'max-w-[75%]'} {isUser ? 'items-end' : 'items-start'}"
		>
			<!-- Sender label -->
			<span class="text-xs font-medium text-muted-foreground">
				{isUser ? userDisplayName : agentName}
			</span>

			{#if isAssistant}
				<!-- Thinking blocks — shown before main text -->
				{#each thinkingBlocks as block, i (i)}
					<ThinkingBlock
						content={block.thinking}
						isStreaming={isStreaming && i === thinkingBlocks.length - 1}
					/>
				{/each}

				<!-- Tool call indicators.
				 argsJson: prefer live tool_call_delta data; fall back to the arguments
				 stored in the content block itself (populated from DB for historical messages).
				 result: only available from live tool_call_end events during the current session.
			-->
				{#each toolCallBlocks as block (block.id)}
					{@const argsJson =
						toolCallArgs[block.id]?.argsJson ??
						(Object.keys(block.arguments).length > 0
							? JSON.stringify(block.arguments, null, 2)
							: undefined)}
					{@const uiCode =
						block.name === 'render_ui' ? extractUiCode(argsJson, block.arguments) : undefined}
					{@const liveCode = block.name === 'render_ui' ? streamingUiCode[block.id] : undefined}
					{@const uiRejected =
						toolResults[block.id]?.startsWith('The UI was NOT rendered') ?? false}
					{#if uiCode && !uiRejected}
						<!-- render_ui — show the generated UI itself instead of a tool indicator -->
						<OpenUiBlock
							code={uiCode}
							disabled={isStreaming}
							onSendMessage={(t) => onUiAction?.(t)}
						/>
					{:else if liveCode && !uiRejected}
						<!-- render_ui still streaming — render the code-so-far progressively -->
						<OpenUiBlock
							code={liveCode}
							streaming
							disabled
							onSendMessage={(t) => onUiAction?.(t)}
						/>
					{:else}
						{@const display = resolveToolDisplay(block.name, argsJson)}
						<ToolCallIndicator
							toolName={block.name}
							toolDisplayName={display.toolDisplayName}
							{argsJson}
							result={toolResults[block.id]}
							images={toolResultImages[block.id]}
							isRunning={isStreaming && !toolResults[block.id]}
							iconUrl={display.type === 'img' ? display.url : undefined}
							iconComponent={display.type === 'icon' ? display.component : undefined}
						/>
					{/if}
				{/each}

				<!-- Main text content — rendered as markdown -->
				{#if combinedText}
					<div class="rounded-2xl rounded-tl-sm px-2 py-2.5">
						<MarkdownRenderer content={combinedText} {isStreaming} />
					</div>
				{/if}

				<!-- Image blocks -->
				{#each imageBlocks as block, i (i)}
					<ImageBlock data={block.data} mimeType={block.mimeType} />
				{/each}

				<!-- Typing indicator (streaming, no text yet) -->
				{#if showTypingIndicator}
					<div class="rounded-2xl rounded-tl-sm bg-muted px-2 py-3">
						<span class="flex items-center gap-1.5">
							<span
								class="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]"
							></span>
							<span
								class="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]"
							></span>
							<span
								class="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]"
							></span>
						</span>
					</div>
				{/if}
			{:else if combinedText}
				{#if userFormMessage}
					<!-- UI form submission — label in the bubble, data in an expandable strip -->
					{#if userFormMessage.label}
						<div class="rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-sm leading-relaxed">
							<p class="font-serif wrap-break-word whitespace-pre-wrap text-primary-foreground">
								{userFormMessage.label}
							</p>
						</div>
					{/if}
					<div class="w-full max-w-72">
						<ToolCallIndicator
							toolName=""
							toolDisplayName="Form data"
							argsJson={userFormMessage.json}
							detailsLabel="Submitted values"
							iconComponent={ClipboardListIcon}
						/>
					</div>
				{:else}
					<!-- User message bubble — wrap-break-word prevents long URLs from overflowing -->
					<div class="rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-sm leading-relaxed">
						<p class="font-serif wrap-break-word whitespace-pre-wrap text-primary-foreground">
							{combinedText}
						</p>
					</div>
				{/if}
			{/if}

			<!-- Attachments (user uploads + agent-shared files) -->
			{#if attachments.length > 0}
				<div class="flex flex-wrap gap-2 {isUser ? 'justify-end' : 'justify-start'}">
					{#each attachments as file (file.id)}
						<ChatAttachment {file} {agentId} {threadId} onOpen={onOpenFile} />
					{/each}
				</div>
			{/if}

			<!-- Token usage (assistant only, shown after streaming completes) -->
			{#if isAssistant && !isStreaming && message.tokenUsage}
				<span class="text-[10px] text-muted-foreground/60">
					{message.tokenUsage.input + message.tokenUsage.output} tokens
				</span>
			{/if}
		</div>
	</div>
{/if}
