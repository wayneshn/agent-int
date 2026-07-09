<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { MissionApproval } from '@repo/types';

	let {
		approvals,
		onDecide,
		busy = false
	}: {
		approvals: MissionApproval[];
		onDecide: (approvalId: string, decision: 'approved' | 'denied', note?: string) => Promise<void>;
		busy?: boolean;
	} = $props();

	const pending = $derived(approvals.filter((a) => a.status === 'pending'));
	const decided = $derived(approvals.filter((a) => a.status !== 'pending').slice(0, 5));

	/** Per-approval note drafts, keyed by approval id */
	let notes = $state<Record<string, string>>({});

	function fmtTime(date: Date | string): string {
		return new Date(date).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function statusVariant(
		status: MissionApproval['status']
	): 'secondary' | 'destructive' | 'outline' {
		if (status === 'approved') return 'secondary';
		if (status === 'denied') return 'destructive';
		return 'outline';
	}
</script>

<Card.Root>
	<Card.Header class="pb-3">
		<Card.Title class="text-sm font-medium">
			Approvals
			{#if pending.length > 0}
				<Badge class="ml-2">{pending.length} pending</Badge>
			{/if}
		</Card.Title>
		<Card.Description class="text-xs">
			Actions the agent wants your permission for. It continues other work while waiting.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		{#if pending.length === 0 && decided.length === 0}
			<p class="py-2 text-center text-xs text-muted-foreground">No approval requests yet.</p>
		{/if}

		{#each pending as approval (approval.id)}
			<div class="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
				<p class="text-sm font-medium text-foreground">{approval.action}</p>
				<p class="text-xs text-muted-foreground">{approval.rationale}</p>
				<p class="text-xs text-muted-foreground">Requested {fmtTime(approval.createdAt)}</p>
				<Textarea
					bind:value={notes[approval.id]}
					placeholder="Optional note for the agent (e.g. conditions, guidance)…"
					class="min-h-16 text-xs"
				/>
				<div class="flex gap-2">
					<Button
						size="sm"
						disabled={busy}
						onclick={() =>
							onDecide(approval.id, 'approved', notes[approval.id]?.trim() || undefined)}
					>
						Approve
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onclick={() => onDecide(approval.id, 'denied', notes[approval.id]?.trim() || undefined)}
					>
						Deny
					</Button>
				</div>
			</div>
		{/each}

		{#if decided.length > 0}
			<div class="flex flex-col gap-2">
				<p class="text-xs font-medium text-muted-foreground">Recently decided</p>
				{#each decided as approval (approval.id)}
					<div class="flex items-center gap-2 text-xs">
						<Badge variant={statusVariant(approval.status)} class="shrink-0 text-[10px]">
							{approval.status}
						</Badge>
						<span class="min-w-0 flex-1 truncate text-muted-foreground">{approval.action}</span>
						{#if approval.decidedAt}
							<span class="shrink-0 text-muted-foreground">{fmtTime(approval.decidedAt)}</span>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</Card.Content>
</Card.Root>
