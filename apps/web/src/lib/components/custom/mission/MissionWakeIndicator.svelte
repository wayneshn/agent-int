<script lang="ts">
	import { onMount } from 'svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import { TOOL_ICON_MAP, DEFAULT_TOOL_ICON } from '$lib/components/custom/chat/tool-icon-map.js';
	import LoaderIcon from '@lucide/svelte/icons/loader-circle';

	/**
	 * Live "the mission is waking right now" banner for the mission detail page.
	 * Shown while an autonomous wake turn is running. `activityTool` (when set)
	 * resolves to the same icon the chat UI uses; otherwise a spinner is shown.
	 * Owns its own 1s elapsed timer so only this component re-renders each tick.
	 */
	let {
		startedAt,
		activityLabel,
		activityTool,
		toolCount
	}: {
		startedAt?: string | Date;
		activityLabel: string;
		activityTool?: string;
		toolCount: number;
	} = $props();

	let now = $state(Date.now());
	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	const elapsed = $derived.by(() => {
		if (!startedAt) return '';
		const secs = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
		const m = Math.floor(secs / 60);
		const s = secs % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	});

	const Icon = $derived(
		activityTool ? (TOOL_ICON_MAP[activityTool] ?? DEFAULT_TOOL_ICON) : LoaderIcon
	);
</script>

<Card.Root class="border-primary/30 bg-primary/5">
	<Card.Content class="flex items-center gap-3 py-3">
		<!-- Pulsing live dot -->
		<span class="relative flex size-2.5 shrink-0">
			<span class="absolute inline-flex size-full animate-ping rounded-full bg-primary/60"></span>
			<span class="relative inline-flex size-2.5 rounded-full bg-primary"></span>
		</span>
		<div class="flex min-w-0 flex-1 flex-col">
			<div class="flex items-center gap-2">
				<span class="text-sm font-medium text-foreground">Waking now</span>
				{#if elapsed}
					<span class="font-mono text-xs text-muted-foreground">· {elapsed}</span>
				{/if}
			</div>
			<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
				<Icon class="size-3.5 shrink-0 {activityTool ? '' : 'animate-spin'}" />
				<span class="truncate">{activityLabel}</span>
				{#if toolCount > 0}
					<span class="shrink-0">· {toolCount} tool call{toolCount === 1 ? '' : 's'}</span>
				{/if}
			</div>
		</div>
	</Card.Content>
</Card.Root>
