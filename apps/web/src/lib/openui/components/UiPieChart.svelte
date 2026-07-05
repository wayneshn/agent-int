<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import { chartPalette, type ChatUiAccent } from '@repo/openui';
	import { browser } from '$app/environment';
	import { PieChart } from 'layerchart';
	import UiChartShell from './UiChartShell.svelte';

	const MAX_SLICES = 6;

	let {
		props
	}: ComponentRenderProps<{
		slices?: { label: string; value: number }[];
		title?: string;
		variant?: 'pie' | 'donut';
		accent?: ChatUiAccent;
	}> = $props();

	// Cap at 6 slices; extras fold into "Other" (never invent hues beyond the palette).
	const data = $derived.by(() => {
		const slices = props.slices ?? [];
		if (slices.length <= MAX_SLICES) return slices;
		const kept = slices.slice(0, MAX_SLICES - 1);
		const other = slices.slice(MAX_SLICES - 1).reduce((sum, s) => sum + (s.value ?? 0), 0);
		return [...kept, { label: 'Other', value: other }];
	});

	// 6th slice (only when folded to "Other") wraps back to the palette start;
	// with ≤5 slices every slice has a unique hue.
	const colors = $derived.by(() => {
		const palette = chartPalette(props.accent);
		return data.map((_, i) => palette[i % palette.length]);
	});
</script>

<UiChartShell title={props.title}>
	{#if browser && data.length > 0}
		<div class="h-60 w-full text-xs text-muted-foreground">
			<PieChart
				{data}
				key="label"
				label="label"
				value="value"
				c="label"
				cRange={colors}
				innerRadius={props.variant === 'donut' ? -24 : 0}
				legend
			/>
		</div>
	{:else}
		<div class="h-60 w-full animate-pulse rounded-md bg-muted/50"></div>
	{/if}
</UiChartShell>
