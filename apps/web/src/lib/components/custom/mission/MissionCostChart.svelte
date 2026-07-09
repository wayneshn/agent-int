<script lang="ts">
	import { browser } from '$app/environment';
	import { AreaChart } from 'layerchart';
	import { scalePoint } from 'd3-scale';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { MissionEvent } from '@repo/types';

	let { events }: { events: MissionEvent[] } = $props();

	// Reconstruct a cumulative cost series from turn_completed events, which carry
	// `data.cost` (estimated USD for that wake) and `data.wakeNumber`. The feed is
	// newest-first, so reverse to chronological before accumulating.
	const rows = $derived.by(() => {
		const completed = events
			.filter(
				(e): e is MissionEvent & { data: { cost: number; wakeNumber?: number } } =>
					e.type === 'turn_completed' &&
					!!e.data &&
					typeof (e.data as Record<string, unknown>).cost === 'number'
			)
			.slice()
			.reverse();
		let cumulative = 0;
		return completed.map((e, i) => {
			cumulative += e.data.cost;
			const wake = typeof e.data.wakeNumber === 'number' ? e.data.wakeNumber : i + 1;
			return { label: `W${wake}`, Cost: Number(cumulative.toFixed(6)) };
		});
	});

	const series = [{ key: 'Cost', color: 'var(--chart-1)' }];
</script>

<Card.Root>
	<Card.Header class="pb-3">
		<Card.Title class="text-sm font-medium">Cost over time</Card.Title>
		<Card.Description class="text-xs">
			Cumulative estimated spend per wake (from the loaded activity window).
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if browser && rows.length >= 2}
			<div class="h-48 w-full text-xs text-muted-foreground">
				<AreaChart data={rows} x="label" {series} xScale={scalePoint()} />
			</div>
		{:else}
			<p class="py-4 text-center text-xs text-muted-foreground">
				Not enough completed wakes yet to chart cost.
			</p>
		{/if}
	</Card.Content>
</Card.Root>
