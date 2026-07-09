<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { formatRelativeTime } from '$lib/format.js';
	import type { DashboardMissionsSummary } from '@repo/types';
	import TargetIcon from '@lucide/svelte/icons/target';
	import ShieldQuestionIcon from '@lucide/svelte/icons/shield-question';

	let { summary }: { summary: DashboardMissionsSummary } = $props();

	const pending = $derived(summary.pendingApprovals);
</script>

<!-- Active-missions tile + a "needs approval" list when there are pending requests. -->
<div class="grid gap-3 lg:grid-cols-3">
	<!-- Active missions stat tile (mirrors home-stats tile styling) -->
	<a
		href="/app/agents"
		class="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-all hover:border-primary/30 hover:shadow-md active:scale-[0.99]"
	>
		<div
			class="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
		>
			<TargetIcon class="size-4" />
		</div>
		<div class="min-w-0">
			<p class="text-2xl leading-none font-semibold tracking-tight text-foreground">
				{summary.activeCount}
			</p>
			<p class="mt-1 truncate text-xs text-muted-foreground">Active missions</p>
		</div>
	</a>

	<!-- Needs-approval card (spans the remaining columns) -->
	<Card.Root class="lg:col-span-2">
		<Card.Header class="pb-3">
			<Card.Title class="text-sm font-medium">
				Needs approval
				{#if pending.length > 0}
					<span
						class="ml-1 inline-flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-white"
					>
						{pending.length}
					</span>
				{/if}
			</Card.Title>
			<Card.Description class="text-xs">Missions waiting on your decision.</Card.Description>
		</Card.Header>
		{#if pending.length === 0}
			<Card.Content>
				<div class="flex items-center gap-2 py-2 text-xs text-muted-foreground">
					<ShieldQuestionIcon class="size-4" />
					Nothing needs your approval right now.
				</div>
			</Card.Content>
		{:else}
			<Card.Content class="p-0">
				<ul class="divide-y divide-border">
					{#each pending as item (item.approvalId)}
						<li>
							<a
								href={`/app/agents/${item.agentId}/missions/${item.missionId}`}
								class="flex items-center gap-3 px-6 py-3 transition-colors hover:bg-muted/50"
							>
								<div
									class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
								>
									<ShieldQuestionIcon class="size-4" />
								</div>
								<div class="min-w-0 flex-1">
									<p class="truncate text-sm font-medium text-foreground">{item.action}</p>
									<p class="mt-0.5 truncate text-xs text-muted-foreground">{item.missionTitle}</p>
								</div>
								<span class="shrink-0 text-xs text-muted-foreground">
									{formatRelativeTime(item.createdAt)}
								</span>
							</a>
						</li>
					{/each}
				</ul>
			</Card.Content>
		{/if}
	</Card.Root>
</div>
