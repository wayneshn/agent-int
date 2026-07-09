<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import PageHeader from '$lib/components/page-header.svelte';
	import MarkdownRenderer from '$lib/components/custom/chat/MarkdownRenderer.svelte';
	import MissionStatusBadge from '$lib/components/custom/mission/MissionStatusBadge.svelte';
	import MissionBudgetBar from '$lib/components/custom/mission/MissionBudgetBar.svelte';
	import MissionActivityFeed from '$lib/components/custom/mission/MissionActivityFeed.svelte';
	import MissionApprovalsCard from '$lib/components/custom/mission/MissionApprovalsCard.svelte';
	import MissionCostChart from '$lib/components/custom/mission/MissionCostChart.svelte';
	import MissionWakeIndicator from '$lib/components/custom/mission/MissionWakeIndicator.svelte';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte';
	import { api } from '$lib/api.client';
	import { get } from 'svelte/store';
	import { authStore } from '$lib/stores/auth.store.js';
	import type { PageData } from './$types';
	import type { AgentMission, MissionApproval, MissionEvent } from '@repo/types';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import PlayIcon from '@lucide/svelte/icons/play';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import CheckIcon from '@lucide/svelte/icons/check';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';

	let { data }: { data: PageData } = $props();

	let mission = $state<AgentMission>(data.mission);
	let events = $state<MissionEvent[]>(data.events);
	let approvals = $state<MissionApproval[]>(data.approvals);
	let busy = $state(false);
	let confirmCompleteOpen = $state(false);

	const base = $derived(`/agents/${data.agent.id}/missions/${mission.id}`);

	/** Refetch mission + events + approvals in one shot (SSE poke and safety poll both use this). */
	async function refetchAll(): Promise<void> {
		try {
			const [missionRes, eventsRes, approvalsRes] = await Promise.all([
				api(base),
				api(`${base}/events?limit=50`),
				api(`${base}/approvals`)
			]);
			if (missionRes.ok) {
				const body = await missionRes.json();
				if (body.success) mission = body.data as AgentMission;
			}
			if (eventsRes.ok) {
				const body = await eventsRes.json();
				if (body.success) events = body.data as MissionEvent[];
			}
			if (approvalsRes.ok) {
				const body = await approvalsRes.json();
				if (body.success) approvals = body.data as MissionApproval[];
			}
		} catch {
			// Transient failure — the next SSE event or safety poll retries.
		}
	}

	// ── Live updates via SSE, with a slow safety poll ───────────────────────────
	// The stream is a change-notification: on each mission_event we debounce-refetch
	// everything (so budget/status/approvals stay consistent, not just the feed).
	// EventSource auto-reconnects on drop; the 30s poll is the belt-and-suspenders.
	onMount(() => {
		let disposed = false;
		let refetchTimer: ReturnType<typeof setTimeout> | null = null;
		const scheduleRefetch = (): void => {
			if (refetchTimer) clearTimeout(refetchTimer);
			refetchTimer = setTimeout(() => void refetchAll(), 300);
		};

		const accessToken = get(authStore).accessToken;
		const url = `/api/v1${base}/stream${accessToken ? `?token=${encodeURIComponent(accessToken)}` : ''}`;
		const es = new EventSource(url);
		es.onmessage = (e) => {
			try {
				const event = JSON.parse(e.data) as { type?: string };
				if (event.type === 'mission_event') scheduleRefetch();
			} catch {
				// ignore malformed frames
			}
		};
		// EventSource reconnects natively on error; nothing to do but let it retry.

		const safety = setInterval(() => {
			if (!disposed) void refetchAll();
		}, 30_000);

		return () => {
			disposed = true;
			es.close();
			clearInterval(safety);
			if (refetchTimer) clearTimeout(refetchTimer);
		};
	});

	// ── Actions ─────────────────────────────────────────────────────────────────
	async function action(path: string, okMessage: string): Promise<void> {
		busy = true;
		try {
			const res = await api(`${base}/${path}`, { method: 'POST' });
			const json = await res.json();
			if (!res.ok || !json.success) {
				setAlert({
					type: 'error',
					title: 'Action failed',
					message: json.error ?? 'Please try again.',
					duration: 6000,
					show: true
				});
				return;
			}
			if (json.data && path !== 'wake') mission = json.data as AgentMission;
			setAlert({ type: 'success', title: okMessage, message: '', duration: 3000, show: true });
		} finally {
			busy = false;
		}
	}

	async function decideApproval(
		approvalId: string,
		decision: 'approved' | 'denied',
		note?: string
	): Promise<void> {
		busy = true;
		try {
			const res = await api(`${base}/approvals/${approvalId}`, {
				method: 'POST',
				body: JSON.stringify({ decision, note })
			});
			const json = await res.json();
			if (!res.ok || !json.success) {
				setAlert({
					type: 'error',
					title: 'Decision failed',
					message: json.error ?? 'Please try again.',
					duration: 6000,
					show: true
				});
				return;
			}
			approvals = approvals.map((a) => (a.id === approvalId ? (json.data as MissionApproval) : a));
			setAlert({
				type: 'success',
				title: `Request ${decision}`,
				message: decision === 'approved' ? 'The mission wakes shortly to act on it.' : '',
				duration: 4000,
				show: true
			});
		} finally {
			busy = false;
		}
	}

	function fmtWake(date: Date | string | undefined): string {
		if (!date) return '—';
		return new Date(date).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	// ── Live "waking now" indicator ─────────────────────────────────────────────
	// A wake is in progress when the mission is active AND the most recent lifecycle
	// event is a `turn_started` with no `turn_completed`/`turn_failed` after it.
	// Events are newest-first and update live via the mission SSE, so this flips as
	// wakes start/finish. Per-tool progress comes from the wake THREAD's chat SSE
	// stream (the wake is an ordinary agent turn), opened below.
	const wakeRunningFromEvents = $derived.by(() => {
		if (mission.status !== 'active') return false;
		const lifecycle = events.find(
			(e) => e.type === 'turn_started' || e.type === 'turn_completed' || e.type === 'turn_failed'
		);
		return lifecycle?.type === 'turn_started';
	});
	const wakeStartedAt = $derived(events.find((e) => e.type === 'turn_started')?.createdAt);

	// Stable key for the wake-thread stream effect — a plain string that only changes
	// when the running wake (its thread) changes, so refetches replacing `mission`
	// don't reopen the stream.
	const currentWakeThreadId = $derived(wakeRunningFromEvents ? mission.currentThreadId : undefined);

	// Live activity from the wake thread's stream.
	let wakeToolCount = $state(0);
	let wakeActivityLabel = $state('Working…');
	let wakeActivityTool = $state<string | undefined>(undefined);
	// Set when the wake thread's stream reports `done` — hides the banner instantly
	// (and covers the rare case where a turn_completed event lags or was lost).
	let wakeStreamDone = $state(false);

	const showWaking = $derived(wakeRunningFromEvents && !wakeStreamDone);

	function friendlyTool(name: string): string {
		const title = name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
		return `Using ${title}`;
	}

	// Subscribe to the running wake thread's chat SSE for live tool-by-tool progress.
	$effect(() => {
		const threadId = currentWakeThreadId;
		if (!threadId) return;
		// Reset live state for this wake.
		wakeToolCount = 0;
		wakeActivityLabel = 'Working…';
		wakeActivityTool = undefined;
		wakeStreamDone = false;

		const token = get(authStore).accessToken;
		const url = `/api/v1/runtime/${data.agent.id}/threads/${threadId}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
		const es = new EventSource(url);
		es.onmessage = (e) => {
			try {
				const ev = JSON.parse(e.data) as { type?: string; toolName?: string };
				switch (ev.type) {
					case 'tool_call_start':
						wakeToolCount += 1;
						if (ev.toolName) {
							wakeActivityTool = ev.toolName;
							wakeActivityLabel = friendlyTool(ev.toolName);
						}
						break;
					case 'tool_call_delta':
						if (ev.toolName) {
							wakeActivityTool = ev.toolName;
							wakeActivityLabel = friendlyTool(ev.toolName);
						}
						break;
					case 'thinking_delta':
						wakeActivityTool = undefined;
						wakeActivityLabel = 'Thinking…';
						break;
					case 'text_delta':
						wakeActivityTool = undefined;
						wakeActivityLabel = 'Writing summary…';
						break;
					case 'done':
						// Wake finished — hide the banner now; the mission SSE will follow
						// up with the turn_completed event and a full refetch.
						wakeStreamDone = true;
						void refetchAll();
						break;
				}
			} catch {
				// ignore malformed frames
			}
		};
		return () => es.close();
	});

	// Goals can be long (a pasted brief). Collapse whitespace and cap the header
	// description so it stays one tidy line; the full goal lives on the Edit page.
	const GOAL_SUMMARY_MAX = 180;
	const goalSummary = $derived.by(() => {
		const collapsed = mission.goal.replace(/\s+/g, ' ').trim();
		return collapsed.length > GOAL_SUMMARY_MAX
			? `${collapsed.slice(0, GOAL_SUMMARY_MAX).trimEnd()}…`
			: collapsed;
	});
</script>

<svelte:head>
	<title>{mission.title} — Missions — Valmis</title>
	<meta name="description" content="Mission detail and activity for {mission.title}." />
</svelte:head>

<PageHeader title={mission.title} description={goalSummary}>
	{#snippet actions()}
		<Button
			variant="outline"
			size="sm"
			class="gap-2"
			onclick={() => goto(`/app/agents/${data.agent.id}/missions`)}
		>
			<ArrowLeftIcon class="size-4" />
			Missions
		</Button>
	{/snippet}
</PageHeader>

<!-- ── Live wake indicator (only while a wake is running) ─────────────────── -->
{#if showWaking}
	<MissionWakeIndicator
		startedAt={wakeStartedAt}
		activityLabel={wakeActivityLabel}
		activityTool={wakeActivityTool}
		toolCount={wakeToolCount}
	/>
{/if}

<!-- ── Status + controls ─────────────────────────────────────────────────── -->
<Card.Root>
	<Card.Content class="flex flex-col gap-4">
		<div class="flex flex-wrap items-center gap-3">
			<MissionStatusBadge status={mission.status} />
			{#if mission.statusReason}
				<span class="text-xs text-muted-foreground"
					>({mission.statusReason.replaceAll('_', ' ')})</span
				>
			{/if}
			{#if mission.status === 'active' && !showWaking}
				<span class="text-xs text-muted-foreground">Next wake: {fmtWake(mission.nextWakeAt)}</span>
			{/if}
			{#if mission.lastWakeAt}
				<span class="text-xs text-muted-foreground">Last wake: {fmtWake(mission.lastWakeAt)}</span>
			{/if}
			{#if mission.consecutiveFailures > 0}
				<span class="text-xs text-destructive"
					>{mission.consecutiveFailures} consecutive failures</span
				>
			{/if}

			<div class="ml-auto flex flex-wrap gap-2">
				{#if mission.currentThreadId}
					<Button
						variant="outline"
						size="sm"
						class="gap-2"
						onclick={() => goto(`/app/chat/${data.agent.id}/${mission.currentThreadId}`)}
					>
						<MessageSquareIcon class="size-4" />
						Steer via chat
					</Button>
				{/if}
				<Button
					variant="outline"
					size="sm"
					class="gap-2"
					onclick={() => goto(`/app/agents/${data.agent.id}/missions/new?id=${mission.id}`)}
				>
					<PencilIcon class="size-4" />
					Edit
				</Button>
				{#if mission.status === 'active'}
					<Button
						variant="outline"
						size="sm"
						class="gap-2"
						disabled={busy}
						onclick={() => action('wake', 'Wake started')}
					>
						<ZapIcon class="size-4" />
						Wake now
					</Button>
					<Button
						variant="outline"
						size="sm"
						class="gap-2"
						disabled={busy}
						onclick={() => action('pause', 'Mission paused')}
					>
						<PauseIcon class="size-4" />
						Pause
					</Button>
				{:else if mission.status === 'paused' || mission.status === 'draft'}
					<Button
						size="sm"
						class="gap-2"
						disabled={busy}
						onclick={() => action('resume', 'Mission active')}
					>
						<PlayIcon class="size-4" />
						{mission.status === 'draft' ? 'Activate' : 'Resume'}
					</Button>
				{/if}
				{#if mission.status === 'active' || mission.status === 'paused'}
					<Button
						variant="outline"
						size="sm"
						class="gap-2"
						disabled={busy}
						onclick={() => (confirmCompleteOpen = true)}
					>
						<CheckIcon class="size-4" />
						Complete
					</Button>
				{/if}
			</div>
		</div>
		<MissionBudgetBar {mission} />
	</Card.Content>
</Card.Root>

<div class="grid gap-6 lg:grid-cols-5">
	<div class="flex flex-col gap-6 lg:col-span-3">
		<MissionActivityFeed {events} />
	</div>
	<div class="flex flex-col gap-6 lg:col-span-2">
		<MissionApprovalsCard {approvals} onDecide={decideApproval} {busy} />
		<MissionCostChart {events} />
		<Card.Root>
			<Card.Header class="pb-3">
				<Card.Title class="text-sm font-medium">Plan document</Card.Title>
				<Card.Description class="text-xs"
					>The agent's own working plan — rewritten as the mission progresses.</Card.Description
				>
			</Card.Header>
			<Card.Content>
				{#if mission.planDocument}
					<div class="prose prose-sm dark:prose-invert max-w-none text-sm">
						<MarkdownRenderer content={mission.planDocument} />
					</div>
				{:else}
					<p class="py-2 text-center text-xs text-muted-foreground">
						No plan yet — the agent writes it on its first wake.
					</p>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>

<!-- ── Complete confirmation ─────────────────────────────────────────────── -->
<Dialog.Root bind:open={confirmCompleteOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Complete this mission?</Dialog.Title>
			<Dialog.Description>
				This stops all future wakes. The mission can't be reactivated afterwards — you'd create a
				new one instead.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (confirmCompleteOpen = false)}>Cancel</Button>
			<Button
				disabled={busy}
				onclick={async () => {
					confirmCompleteOpen = false;
					await action('complete', 'Mission completed');
				}}
			>
				Complete mission
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
