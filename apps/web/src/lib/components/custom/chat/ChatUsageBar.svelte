<script lang="ts">
	import { chatPrefsStore } from '$lib/stores/chat-prefs.store.js';
	import { browser } from '$app/environment';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import FoldVerticalIcon from '@lucide/svelte/icons/fold-vertical';
	import LoaderIcon from '@lucide/svelte/icons/loader-circle';

	interface Props {
		/**
		 * Input token count from the most recent LLM call.
		 * LLM providers count the full message history as input on every call,
		 * so this equals the current context occupancy. Used for the fill bar.
		 * Seeded from DB on page load so it reflects the thread's actual state.
		 */
		latestInputTokens: number;
		/**
		 * Cumulative cost for this thread in USD.
		 * Seeded from DB totals on load and accumulated with new turns.
		 */
		sessionCost: number;
		/** Model's max context window in tokens — null for unknown/custom models */
		modelContextLength: number | null;
		/**
		 * Called when the user clicks "Compact" — summarizes the conversation so far
		 * and shrinks what the agent receives next turn. Omit to hide the button.
		 */
		onCompact?: () => void;
		/** True while a compaction request is in flight — shows a spinner and disables the button */
		compacting?: boolean;
		/** True while the agent is streaming — compaction is disabled mid-turn */
		streaming?: boolean;
	}

	let {
		latestInputTokens,
		sessionCost,
		modelContextLength,
		onCompact,
		compacting = false,
		streaming = false,
	}: Props = $props();

	/** Initialise the store from localStorage on mount (browser only) */
	$effect(() => {
		if (browser) chatPrefsStore.init();
	});

	const showUsage = $derived($chatPrefsStore);

	/**
	 * Context window fill percentage (0–100).
	 * Uses latestInputTokens because providers count ALL history as input on
	 * every call — so the most recent turn's input = current context occupancy.
	 */
	const ctxPct = $derived.by(() => {
		if (!modelContextLength || modelContextLength === 0 || latestInputTokens === 0) return 0;
		return Math.min(100, Math.round((latestInputTokens / modelContextLength) * 100));
	});

	function fmtTokens(n: number): string {
		if (n === 0) return '—';
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return String(n);
	}

	function fmtCost(usd: number): string {
		if (usd === 0) return '$0.00';
		if (usd < 0.001) return `$${usd.toFixed(6)}`;
		if (usd < 0.01) return `$${usd.toFixed(4)}`;
		return `$${usd.toFixed(4)}`;
	}

	function fmtContextLength(n: number): string {
		if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
		if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
		return String(n);
	}
</script>

<!--
  Subtle token/cost status bar rendered between the message list and ChatInput.
  Visibility is toggled via a persistent localStorage preference (chatPrefsStore).
-->
<div class="flex items-center justify-end gap-2 px-2 py-1">
	{#if showUsage}
		<div class="flex items-center gap-3 text-xs text-muted-foreground">
			<!-- Context window fill (latestInputTokens = current context occupancy) -->
			{#if modelContextLength && latestInputTokens > 0}
				<span class="flex items-center gap-1.5">
					<div class="h-1 w-14 overflow-hidden rounded-full bg-muted">
						<div
							class="h-full rounded-full bg-primary/50 transition-all duration-300"
							style="width: {ctxPct}%"
						></div>
					</div>
					<span class="tabular-nums">
						{fmtTokens(latestInputTokens)} / {fmtContextLength(modelContextLength)}
					</span>
				</span>
				<span class="text-muted-foreground/40">·</span>
			{:else if latestInputTokens > 0}
				<span class="tabular-nums">{fmtTokens(latestInputTokens)} ctx</span>
				<span class="text-muted-foreground/40">·</span>
			{/if}

			<!-- Thread cumulative cost (seeded from DB, accumulated live) -->
			<span class="tabular-nums">{fmtCost(sessionCost)}</span>
		</div>
	{/if}

	<!-- Compact context — summarizes the conversation so far to free up context -->
	{#if onCompact}
		<button
			type="button"
			onclick={() => onCompact?.()}
			disabled={compacting || streaming || latestInputTokens === 0}
			class="flex items-center gap-1 text-muted-foreground/60 transition-colors hover:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-40"
			title={streaming
				? 'Wait for the agent to finish before compacting'
				: 'Summarize and shrink this conversation to free up context'}
			aria-label="Compact context"
		>
			{#if compacting}
				<LoaderIcon class="size-3 animate-spin" />
			{:else}
				<FoldVerticalIcon class="size-3" />
			{/if}
			<span class="text-xs">{compacting ? 'Compacting…' : 'Compact'}</span>
		</button>
	{/if}

	<!-- Toggle button — always visible so users can show/hide -->
	<button
		type="button"
		onclick={() => chatPrefsStore.toggleShowUsage()}
		class="text-muted-foreground/50 transition-colors hover:text-muted-foreground"
		title={showUsage ? 'Hide usage stats' : 'Show usage stats'}
		aria-label={showUsage ? 'Hide usage stats' : 'Show usage stats'}
	>
		{#if showUsage}
			<EyeIcon class="size-3" />
		{:else}
			<EyeOffIcon class="size-3" />
		{/if}
	</button>
</div>
