<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import type { ChatUiAccent } from '@repo/openui';
	import { browser } from '$app/environment';
	import { BarChart } from 'layerchart';
	import { scaleBand } from 'd3-scale';
	import UiChartShell from './UiChartShell.svelte';
	import { toChartRows, toChartSeries, type ChartSeriesInput } from '../charts';

	let {
		props
	}: ComponentRenderProps<{
		labels?: string[];
		series?: ChartSeriesInput[];
		title?: string;
		variant?: 'grouped' | 'stacked' | 'horizontal';
		accent?: ChatUiAccent;
	}> = $props();

	const rows = $derived(toChartRows(props.labels, props.series));
	const chartSeries = $derived(toChartSeries(props.series, props.accent));
	// Legend is the relief channel for series identity — always shown for >1 series.
	const showLegend = $derived(chartSeries.length > 1);
	const horizontal = $derived(props.variant === 'horizontal');
</script>

<UiChartShell title={props.title}>
	{#if browser && rows.length > 0}
		<div class="h-56 w-full text-xs text-muted-foreground">
			<BarChart
				data={rows}
				x={horizontal ? undefined : 'label'}
				y={horizontal ? 'label' : undefined}
				series={chartSeries}
				seriesLayout={props.variant === 'stacked' ? 'stack' : 'group'}
				orientation={horizontal ? 'horizontal' : 'vertical'}
				xScale={horizontal ? undefined : scaleBand().padding(0.3)}
				yScale={horizontal ? scaleBand().padding(0.3) : undefined}
				legend={showLegend}
				props={{ bars: { rounded: 'edge', radius: 4 } }}
			/>
		</div>
	{:else}
		<div class="h-56 w-full animate-pulse rounded-md bg-muted/50"></div>
	{/if}
</UiChartShell>
