<script lang="ts">
	import { Progress } from '$lib/components/ui/progress/index.js';
	import type { AgentMission } from '@repo/types';

	let { mission, compact = false }: { mission: AgentMission; compact?: boolean } = $props();

	const pct = $derived(
		mission.maxCostTotal > 0
			? Math.min(100, Math.round((mission.costTotal / mission.maxCostTotal) * 100))
			: 0
	);
	const money = (n: number): string =>
		n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n === 0 ? 2 : 4)}`;
</script>

<div class="flex flex-col gap-1.5">
	<div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
		<span>{money(mission.costTotal)} of {money(mission.maxCostTotal)} budget</span>
		<span>{pct}%</span>
	</div>
	<Progress value={pct} class={compact ? 'h-1.5' : 'h-2'} />
	{#if !compact}
		<div class="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
			{#if mission.maxCostPerDay !== undefined}
				<span>Today: {money(mission.costToday)} / {money(mission.maxCostPerDay)}</span>
			{/if}
			{#if mission.maxTurnsPerDay !== undefined}
				<span>Wakes today: {mission.turnsToday} / {mission.maxTurnsPerDay}</span>
			{/if}
			<span>Total wakes: {mission.totalTurns}</span>
			<span class="italic">Cost figures are model-catalog estimates.</span>
		</div>
	{/if}
</div>
