<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import type { ChatUiAccent } from '@repo/openui';
	import { browser } from '$app/environment';
	import { AreaChart, LineChart } from 'layerchart';
	import { scalePoint } from 'd3-scale';
	import UiChartShell from './UiChartShell.svelte';
	import { toChartRows, toChartSeries, type ChartSeriesInput } from '../charts';

	let {
		props
	}: ComponentRenderProps<{
		labels?: string[];
		series?: ChartSeriesInput[];
		title?: string;
		variant?: 'line' | 'area';
		accent?: ChatUiAccent;
	}> = $props();

	const rows = $derived(toChartRows(props.labels, props.series));
	const chartSeries = $derived(toChartSeries(props.series, props.accent));
	const showLegend = $derived(chartSeries.length > 1);
</script>

<UiChartShell title={props.title}>
	{#if browser && rows.length > 0}
		<div class="h-56 w-full text-xs text-muted-foreground">
			{#if props.variant === 'area'}
				<AreaChart
					data={rows}
					x="label"
					series={chartSeries}
					xScale={scalePoint()}
					legend={showLegend}
				/>
			{:else}
				<LineChart
					data={rows}
					x="label"
					series={chartSeries}
					xScale={scalePoint()}
					legend={showLegend}
				/>
			{/if}
		</div>
	{:else}
		<div class="h-56 w-full animate-pulse rounded-md bg-muted/50"></div>
	{/if}
</UiChartShell>
