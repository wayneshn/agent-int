<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import { accentChartVar, type ChatUiAccent } from '@repo/openui';
	import TrendingUpIcon from '@lucide/svelte/icons/trending-up';
	import TrendingDownIcon from '@lucide/svelte/icons/trending-down';
	import MinusIcon from '@lucide/svelte/icons/minus';

	let {
		props
	}: ComponentRenderProps<{
		label: string;
		value: string;
		delta?: string;
		trend?: 'up' | 'down' | 'flat';
		accent?: ChatUiAccent;
	}> = $props();

	const trendClass = $derived.by(() => {
		switch (props.trend) {
			case 'up':
				return 'text-green-700 dark:text-green-400';
			case 'down':
				return 'text-destructive';
			default:
				return 'text-muted-foreground';
		}
	});
</script>

<div class="flex min-w-0 flex-col gap-1 rounded-2xl bg-card p-4 ring-1 ring-foreground/10">
	<div class="flex items-center gap-1.5">
		<span
			class="size-1.5 shrink-0 rounded-full"
			style="background-color: {accentChartVar(props.accent)}"
		></span>
		<span class="truncate text-xs text-muted-foreground">{props.label}</span>
	</div>
	<span class="text-2xl font-semibold tracking-tight text-foreground tabular-nums">
		{props.value}
	</span>
	{#if props.delta}
		<span class="flex items-center gap-1 text-xs {trendClass}">
			{#if props.trend === 'up'}
				<TrendingUpIcon class="size-3.5" />
			{:else if props.trend === 'down'}
				<TrendingDownIcon class="size-3.5" />
			{:else}
				<MinusIcon class="size-3.5" />
			{/if}
			{props.delta}
		</span>
	{/if}
</div>
