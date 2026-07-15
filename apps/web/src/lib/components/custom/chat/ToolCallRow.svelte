<script lang="ts">
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { DEFAULT_TOOL_ICON } from './tool-icon-map.js';
	import ToolCallDetails from './ToolCallDetails.svelte';

	/**
	 * One tool call rendered as a borderless row inside a ToolCallGroup rail.
	 * The running/done status lives on the group's rail node, so the row stays
	 * quiet — just an icon, a label, and (when there's content) an expand chevron
	 * revealing the args/result panel.
	 */
	let {
		toolName,
		toolDisplayName,
		argsJson,
		detailsLabel = 'Arguments',
		result,
		images,
		isRunning = false,
		iconUrl,
		iconComponent
	}: {
		toolName: string;
		/** Pre-formatted display label — overrides the default snake_case formatter */
		toolDisplayName?: string;
		/** Pretty-printed JSON args the LLM decided to pass — the "thinking context" */
		argsJson?: string;
		/** Heading for the argsJson section — defaults to 'Arguments' */
		detailsLabel?: string;
		/** Raw tool execution output returned to the agent */
		result?: string;
		/** Image content blocks returned by the tool (e.g. a browser screenshot) */
		images?: { data: string; mimeType: string }[];
		isRunning?: boolean;
		/** Integration logo URL — shown when call_api is used with a known credential */
		iconUrl?: string;
		/** Lucide icon constructor — shown for built-in tools */
		iconComponent?: typeof WrenchIcon;
	} = $props();

	let expanded = $state(false);

	/** Whether there is any expandable content to show */
	let hasDetails = $derived(!!(argsJson || result || (images && images.length > 0)));

	/** Whether the expand button should be interactive */
	let canExpand = $derived(!isRunning && hasDetails);

	/** Format tool name from snake_case to a human-readable label */
	function formatToolName(name: string): string {
		if (!name) return 'Using tool…';
		return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
	}

	/** Resolved display label — prefer toolDisplayName prop, fall back to formatter */
	let displayLabel = $derived(toolDisplayName ?? formatToolName(toolName));

	/** Resolved icon component — iconComponent prop, or DEFAULT_TOOL_ICON fallback */
	let ResolvedIcon = $derived(iconComponent ?? DEFAULT_TOOL_ICON);
</script>

<div>
	<button
		type="button"
		class="group/row flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground disabled:pointer-events-none"
		onclick={() => canExpand && (expanded = !expanded)}
		disabled={!canExpand}
	>
		<!-- Icon: integration logo image takes priority over Lucide icon -->
		{#if iconUrl}
			<img
				src={iconUrl}
				alt=""
				class="size-3.5 shrink-0 rounded-sm object-contain opacity-80"
				onerror={(e) => {
					// Hide broken images — the text label still identifies the tool
					(e.currentTarget as HTMLImageElement).style.display = 'none';
				}}
			/>
		{:else}
			<ResolvedIcon class="size-3 shrink-0 opacity-60" />
		{/if}

		<span class="flex-1 truncate font-medium">{displayLabel.replace('Api', 'API')}</span>

		{#if hasDetails && !isRunning}
			<ChevronDownIcon
				class="size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150 {expanded
					? 'rotate-180'
					: ''}"
			/>
		{/if}
	</button>

	{#if expanded && hasDetails}
		<div class="mt-1 overflow-hidden rounded-md border border-border/30 bg-muted/20">
			<ToolCallDetails {argsJson} {detailsLabel} {result} {images} />
		</div>
	{/if}
</div>
