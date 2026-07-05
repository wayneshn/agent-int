<script lang="ts">
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CheckIcon from '@lucide/svelte/icons/check';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { DEFAULT_TOOL_ICON } from './tool-icon-map.js';
	import ImageBlock from './ImageBlock.svelte';

	/**
	 * Expandable tool call strip shown inside assistant messages.
	 *
	 * While running (isRunning=true): shows tool name + animated dots.
	 * After the LLM has formed the call (argsJson present): name is updated.
	 * After execution (result present): expandable to show args + result.
	 *
	 * Icon resolution priority:
	 *  1. iconUrl  — integration logo image (e.g. /logos/github.svg) for call_api with credential
	 *  2. iconComponent — Lucide icon constructor from TOOL_ICON_MAP for built-in tools
	 *  3. DEFAULT_TOOL_ICON (WrenchIcon) — ultimate fallback
	 *
	 * Label resolution priority:
	 *  1. toolDisplayName — pre-formatted label (e.g. "Call Api — GitHub") for call_api
	 *  2. formatToolName(toolName) — snake_case → title-case formatter fallback
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
		/** Heading for the argsJson section — defaults to 'Arguments' (tool calls) */
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

<div class="my-1 overflow-hidden rounded-md border border-border/40 bg-muted/20">
	<!-- Header strip — always visible -->
	<button
		type="button"
		class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 disabled:pointer-events-none"
		onclick={() => canExpand && (expanded = !expanded)}
		disabled={!canExpand}
	>
		<!-- Icon: integration logo image takes priority over Lucide icon -->
		{#if iconUrl}
			<img
				src={iconUrl}
				alt=""
				class="size-4 shrink-0 rounded-sm object-contain opacity-80"
				onerror={(e) => {
					// Hide broken images — the text label still identifies the tool
					(e.currentTarget as HTMLImageElement).style.display = 'none';
				}}
			/>
		{:else}
			<ResolvedIcon class="size-3 shrink-0 opacity-60" />
		{/if}

		<span class="flex-1 font-medium">{displayLabel.replace('Api', 'API')}</span>

		{#if isRunning}
			<!-- Spinning loader while the tool is being invoked -->
			<LoaderCircleIcon class="size-3 shrink-0 animate-spin text-muted-foreground/60" />
		{:else}
			<CheckIcon class="size-3 shrink-0 text-green-500" />
			{#if hasDetails}
				<ChevronDownIcon
					class="size-3 shrink-0 transition-transform duration-150 {expanded ? 'rotate-180' : ''}"
				/>
			{/if}
		{/if}
	</button>

	<!-- Expandable detail panel -->
	{#if expanded && hasDetails}
		<div class="divide-y divide-border/30 border-t border-border/40">
			{#if argsJson}
				<!-- Arguments — what the agent chose to pass to the tool -->
				<div class="px-3 py-2">
					<p
						class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground/60 uppercase"
					>
						{detailsLabel}
					</p>
					<pre
						class="overflow-x-auto font-mono text-[11px] leading-relaxed wrap-break-word break-all whitespace-pre-wrap text-muted-foreground/80">{argsJson}</pre>
				</div>
			{/if}

			{#if result}
				<!-- Result — raw tool execution output -->
				<div class="px-3 py-2">
					<p
						class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground/60 uppercase"
					>
						Result
					</p>
					<pre
						class="overflow-x-auto font-mono text-[11px] leading-relaxed wrap-break-word break-all whitespace-pre-wrap text-muted-foreground/80">{result}</pre>
				</div>
			{/if}

			{#if images && images.length > 0}
				<!-- Image results — e.g. a browser screenshot -->
				<div class="px-3 py-2">
					<p
						class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground/60 uppercase"
					>
						Image
					</p>
					{#each images as image, i (i)}
						<ImageBlock data={image.data} mimeType={image.mimeType} />
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>
