<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { MissionEvent, MissionEventType } from '@repo/types';
	import ActivityIcon from '@lucide/svelte/icons/activity';

	let {
		events,
		hasMore = false,
		onLoadMore
	}: {
		events: MissionEvent[];
		hasMore?: boolean;
		onLoadMore?: () => void;
	} = $props();

	function typeLabel(type: MissionEventType): string {
		switch (type) {
			case 'turn_started':
				return 'Wake started';
			case 'turn_completed':
				return 'Wake completed';
			case 'turn_failed':
				return 'Wake failed';
			case 'wake_scheduled':
				return 'Wake scheduled';
			case 'wake_deferred':
				return 'Wake deferred';
			case 'plan_updated':
				return 'Plan updated';
			case 'log':
				return 'Log';
			case 'report':
				return 'Report';
			case 'budget_exceeded':
				return 'Budget';
			case 'approval_requested':
				return 'Approval requested';
			case 'approval_resolved':
				return 'Approval decided';
			case 'status_changed':
				return 'Status';
			default:
				return type;
		}
	}

	function typeVariant(
		type: MissionEventType
	): 'default' | 'secondary' | 'destructive' | 'outline' {
		switch (type) {
			case 'turn_failed':
			case 'budget_exceeded':
				return 'destructive';
			case 'report':
			case 'approval_requested':
				return 'default';
			case 'log':
			case 'plan_updated':
				return 'secondary';
			default:
				return 'outline';
		}
	}

	function fmtTime(date: Date | string): string {
		const d = new Date(date);
		return d.toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
</script>

<Card.Root>
	<Card.Header class="pb-3">
		<Card.Title class="text-sm font-medium">Activity</Card.Title>
		<Card.Description class="text-xs">What the mission did and why — newest first.</Card.Description
		>
	</Card.Header>
	<Card.Content class="flex flex-col gap-0 p-0">
		{#if events.length === 0}
			<div class="flex flex-col items-center gap-3 px-6 py-10">
				<div
					class="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
				>
					<ActivityIcon class="size-5" />
				</div>
				<div class="text-center">
					<p class="text-sm font-medium text-foreground">No activity yet</p>
					<p class="mt-0.5 text-xs text-muted-foreground">
						Events appear here once the mission starts waking.
					</p>
				</div>
			</div>
		{:else}
			<ul class="divide-y divide-border/60">
				{#each events as event (event.id)}
					<li class="flex flex-col gap-1 px-6 py-3">
						<div class="flex items-center gap-2">
							<Badge variant={typeVariant(event.type)} class="shrink-0 text-[10px]">
								{typeLabel(event.type)}
							</Badge>
							<span class="min-w-0 flex-1 truncate text-sm text-foreground">{event.title}</span>
							<span class="shrink-0 text-xs text-muted-foreground">{fmtTime(event.createdAt)}</span>
						</div>
						{#if event.body}
							<p class="pl-1 text-xs whitespace-pre-wrap text-muted-foreground">{event.body}</p>
						{/if}
					</li>
				{/each}
			</ul>
			{#if hasMore && onLoadMore}
				<div class="border-t border-border/60 px-6 py-3">
					<Button variant="ghost" size="sm" class="w-full" onclick={onLoadMore}>Load older</Button>
				</div>
			{/if}
		{/if}
	</Card.Content>
</Card.Root>
