<script lang="ts">
	import { goto } from '$app/navigation';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import PageHeader from '$lib/components/page-header.svelte';
	import type { PageData } from './$types';
	import type { AgentRunSummary } from '@repo/types';
	import BotIcon from '@lucide/svelte/icons/bot';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import CoinsIcon from '@lucide/svelte/icons/coins';
	import ZapIcon from '@lucide/svelte/icons/zap';

	let { data }: { data: PageData } = $props();

	// ── Helpers ────────────────────────────────────────────────────────────────

	function fmt(n: number): string {
		return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
	}

	function fmtCost(usd: number): string {
		if (usd === 0) return '$0.00';
		if (usd < 0.001) return `$${usd.toFixed(6)}`;
		if (usd < 0.01) return `$${usd.toFixed(4)}`;
		return `$${usd.toFixed(4)}`;
	}

	function fmtRelative(date: Date | string): string {
		const d = new Date(date);
		const diff = Date.now() - d.getTime();
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function fmtDuration(run: AgentRunSummary): string {
		const ms = new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime();
		if (ms < 1000) return '<1s';
		const secs = Math.floor(ms / 1000);
		if (secs < 60) return `${secs}s`;
		const mins = Math.floor(secs / 60);
		return `${mins}m ${secs % 60}s`;
	}

	function statusVariant(
		status: AgentRunSummary['status']
	): 'default' | 'secondary' | 'destructive' | 'outline' {
		switch (status) {
			case 'running':
				return 'default';
			case 'completed':
				return 'secondary';
			case 'error':
				return 'destructive';
			default:
				return 'outline';
		}
	}

	function triggerLabel(type: AgentRunSummary['triggerType']): string {
		switch (type) {
			case 'chat':
				return 'Chat';
			case 'cron':
				return 'Cron';
			case 'webhook':
				return 'Webhook';
			case 'manual':
				return 'Manual';
			case 'app':
				return 'App';
			case 'agent':
				return 'Agent';
			default:
				return 'Run';
		}
	}

	function ctxPct(lastInputTokens: number, contextLength: number | null): number {
		if (!contextLength || contextLength === 0 || lastInputTokens === 0) return 0;
		return Math.min(100, Math.round((lastInputTokens / contextLength) * 100));
	}

	// ── Aggregate totals ───────────────────────────────────────────────────────
	const totalCost = $derived(data.runs.reduce((s, r) => s + r.totalCost, 0));
	const totalTokens = $derived(
		data.runs.reduce((s, r) => s + r.totalInputTokens + r.totalOutputTokens, 0)
	);
	const activeRuns = $derived(data.runs.filter((r) => r.status === 'running').length);
</script>

<svelte:head>
	<title>{data.agent.name} — Details — Valmis</title>
	<meta
		name="description"
		content="View execution history, token usage, and costs for {data.agent.name}."
	/>
</svelte:head>

<!-- ── Page header ───────────────────────────────────────────────────────── -->
<PageHeader
	title="Details - {data.agent.name}"
	description="Execution history, token usage, and cost for {data.agent.name}."
>
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={() => goto('/app/agents')} class="gap-2">
			<ArrowLeftIcon class="size-4" />
			Back to agents
		</Button>
	{/snippet}
</PageHeader>

<!-- ── Summary cards ─────────────────────────────────────────────────────── -->
<div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
	<Card.Root>
		<Card.Content class="pt-6">
			<div class="flex items-center gap-3">
				<div class="flex size-9 items-center justify-center rounded-lg bg-muted">
					<ActivityIcon class="size-4 text-muted-foreground" />
				</div>
				<div>
					<p class="text-2xl leading-none font-semibold">{data.runs.length}</p>
					<p class="mt-1 text-xs text-muted-foreground">Total sessions</p>
				</div>
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Content class="pt-6">
			<div class="flex items-center gap-3">
				<div class="flex size-9 items-center justify-center rounded-lg bg-muted">
					<ZapIcon class="size-4 text-muted-foreground" />
				</div>
				<div>
					<p class="text-2xl leading-none font-semibold">{activeRuns}</p>
					<p class="mt-1 text-xs text-muted-foreground">Running now</p>
				</div>
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Content class="pt-6">
			<div class="flex items-center gap-3">
				<div class="flex size-9 items-center justify-center rounded-lg bg-muted">
					<MessageSquareIcon class="size-4 text-muted-foreground" />
				</div>
				<div>
					<p class="text-2xl leading-none font-semibold">{fmt(totalTokens)}</p>
					<p class="mt-1 text-xs text-muted-foreground">Total tokens</p>
				</div>
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Content class="pt-6">
			<div class="flex items-center gap-3">
				<div class="flex size-9 items-center justify-center rounded-lg bg-muted">
					<CoinsIcon class="size-4 text-muted-foreground" />
				</div>
				<div>
					<p class="text-2xl leading-none font-semibold">{fmtCost(totalCost)}</p>
					<p class="mt-1 text-xs text-muted-foreground">Total cost</p>
				</div>
			</div>
		</Card.Content>
	</Card.Root>
</div>

<!-- ── Runs table ─────────────────────────────────────────────────────────── -->
<Card.Root>
	<Card.Header class="pb-3">
		<Card.Title class="text-sm font-medium">Sessions</Card.Title>
		<Card.Description class="text-xs">Click a row to open the conversation.</Card.Description>
	</Card.Header>

	{#if data.runs.length === 0}
		<Card.Content>
			<div class="flex flex-col items-center gap-3 py-10">
				<div
					class="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
				>
					<BotIcon class="size-5" />
				</div>
				<div class="text-center">
					<p class="text-sm font-medium text-foreground">No runs yet</p>
					<p class="mt-0.5 text-xs text-muted-foreground">
						Start a chat or trigger to create the first run.
					</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					onclick={() => goto(`/app/chat/${data.agent.id}`)}
					class="gap-2"
				>
					<MessageSquareIcon class="size-4" />
					Open chat
				</Button>
			</div>
		</Card.Content>
	{:else}
		<Card.Content class="p-0">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Thread</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head class="text-right">Messages</Table.Head>
						<Table.Head class="text-right">Tool calls</Table.Head>
						<Table.Head class="text-right">Tokens (in / out)</Table.Head>
						{#if data.modelContextLength}
							<Table.Head>Context</Table.Head>
						{/if}
						<Table.Head class="text-right">Cost</Table.Head>
						<Table.Head class="text-right">Duration</Table.Head>
						<Table.Head class="text-right">Started</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.runs as run (run.id)}
						{@const pct = ctxPct(run.lastInputTokens, data.modelContextLength)}
						<Table.Row
							class="cursor-pointer"
							onclick={() => goto(`/app/chat/${run.agentId}/${run.id}`)}
						>
							<!-- Thread title + trigger type -->
							<Table.Cell class="max-w-[200px]">
								<div class="flex items-center gap-2">
									<span class="truncate font-medium">{run.title ?? 'Untitled'}</span>
									<Badge variant="outline" class="shrink-0 text-xs">
										{triggerLabel(run.triggerType)}
									</Badge>
								</div>
							</Table.Cell>

							<!-- Status -->
							<Table.Cell>
								<Badge variant={statusVariant(run.status)} class="text-xs capitalize">
									{run.status}
								</Badge>
							</Table.Cell>

							<!-- Messages -->
							<Table.Cell class="text-right text-muted-foreground tabular-nums">
								{run.messageCount}
							</Table.Cell>

							<!-- Tool calls -->
							<Table.Cell class="text-right text-muted-foreground tabular-nums">
								{#if run.toolCallCount > 0}
									<span class="inline-flex items-center gap-1">
										<WrenchIcon class="size-3" />
										{run.toolCallCount}
									</span>
								{:else}
									—
								{/if}
							</Table.Cell>

							<!-- Tokens in / out -->
							<Table.Cell class="text-right text-muted-foreground tabular-nums">
								{#if run.totalInputTokens > 0 || run.totalOutputTokens > 0}
									{fmt(run.totalInputTokens)} / {fmt(run.totalOutputTokens)}
								{:else}
									—
								{/if}
							</Table.Cell>

							<!-- Context window fill bar -->
							{#if data.modelContextLength}
								<Table.Cell>
									{#if run.lastInputTokens > 0}
										<div class="flex items-center gap-2">
											<div class="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
												<div
													class="h-full rounded-full bg-primary/60 transition-all"
													style="width: {pct}%"
												></div>
											</div>
											<span class="text-xs text-muted-foreground tabular-nums">{pct}%</span>
										</div>
									{:else}
										<span class="text-muted-foreground">—</span>
									{/if}
								</Table.Cell>
							{/if}

							<!-- Cost -->
							<Table.Cell class="text-right text-muted-foreground tabular-nums">
								{run.totalCost > 0 ? fmtCost(run.totalCost) : '—'}
							</Table.Cell>

							<!-- Duration -->
							<Table.Cell class="text-right text-muted-foreground tabular-nums">
								{fmtDuration(run)}
							</Table.Cell>

							<!-- Started at -->
							<Table.Cell class="text-right text-muted-foreground">
								{fmtRelative(run.createdAt)}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Content>
	{/if}
</Card.Root>
