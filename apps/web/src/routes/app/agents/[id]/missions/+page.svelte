<script lang="ts">
	import { goto } from '$app/navigation';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import PageHeader from '$lib/components/page-header.svelte';
	import MissionStatusBadge from '$lib/components/custom/mission/MissionStatusBadge.svelte';
	import MissionBudgetBar from '$lib/components/custom/mission/MissionBudgetBar.svelte';
	import type { PageData } from './$types';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TargetIcon from '@lucide/svelte/icons/target';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	let { data }: { data: PageData } = $props();

	function fmtWake(date: Date | string | undefined): string {
		if (!date) return '—';
		const d = new Date(date);
		const diff = d.getTime() - Date.now();
		if (diff <= 0) return 'due now';
		const mins = Math.round(diff / 60_000);
		if (mins < 60) return `in ${mins}m`;
		const hrs = Math.round(mins / 60);
		if (hrs < 24) return `in ${hrs}h`;
		return d.toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
</script>

<svelte:head>
	<title>Missions — {data.agent.name} — Valmis</title>
	<meta name="description" content="Autonomous long-term missions for {data.agent.name}." />
</svelte:head>

<PageHeader
	title="Missions"
	description="Long-term goals {data.agent
		.name} pursues autonomously — it plans, acts, and reports on its own schedule."
>
	{#snippet actions()}
		<Button variant="outline" size="sm" class="gap-2" onclick={() => goto('/app/agents')}>
			<ArrowLeftIcon class="size-4" />
			Agents
		</Button>
		<Button
			size="sm"
			class="gap-2"
			onclick={() => goto(`/app/agents/${data.agent.id}/missions/new`)}
		>
			<PlusIcon class="size-4" />
			New mission
		</Button>
	{/snippet}
</PageHeader>

{#if data.missions.length === 0}
	<Card.Root>
		<Card.Content>
			<div class="flex flex-col items-center gap-3 py-12">
				<div
					class="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
				>
					<TargetIcon class="size-5" />
				</div>
				<div class="text-center">
					<p class="text-sm font-medium text-foreground">No missions yet</p>
					<p class="mt-0.5 max-w-md text-xs text-muted-foreground">
						Give {data.agent.name} a long-term goal with a hard budget, and it will work toward it autonomously
						— waking itself up, planning, acting, and reporting back.
					</p>
				</div>
				<Button
					size="sm"
					class="gap-2"
					onclick={() => goto(`/app/agents/${data.agent.id}/missions/new`)}
				>
					<PlusIcon class="size-4" />
					Create the first mission
				</Button>
			</div>
		</Card.Content>
	</Card.Root>
{:else}
	<div class="grid gap-4 md:grid-cols-2">
		{#each data.missions as mission (mission.id)}
			<Card.Root
				class="cursor-pointer transition-colors hover:bg-muted/40"
				onclick={() => goto(`/app/agents/${data.agent.id}/missions/${mission.id}`)}
			>
				<Card.Header class="pb-3">
					<div class="flex items-start justify-between gap-2">
						<Card.Title class="text-sm font-medium">{mission.title}</Card.Title>
						<MissionStatusBadge status={mission.status} />
					</div>
					<Card.Description class="line-clamp-2 text-xs">{mission.goal}</Card.Description>
				</Card.Header>
				<Card.Content class="flex flex-col gap-3">
					<MissionBudgetBar {mission} compact />
					<div class="flex items-center gap-4 text-xs text-muted-foreground">
						<span class="flex items-center gap-1">
							<ClockIcon class="size-3.5" />
							{#if mission.status === 'active'}
								Next wake {fmtWake(mission.nextWakeAt)}
							{:else if mission.lastWakeAt}
								Last wake {fmtWake(mission.lastWakeAt)}
							{:else}
								Never woken
							{/if}
						</span>
						<span>{mission.totalTurns} wakes</span>
						{#if mission.consecutiveFailures > 0}
							<span class="text-destructive">{mission.consecutiveFailures} failures</span>
						{/if}
					</div>
				</Card.Content>
			</Card.Root>
		{/each}
	</div>
{/if}
