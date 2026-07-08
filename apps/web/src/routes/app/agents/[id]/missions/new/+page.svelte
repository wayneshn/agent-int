<script lang="ts">
	import { goto } from '$app/navigation';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import PageHeader from '$lib/components/page-header.svelte';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte';
	import { api } from '$lib/api.client';
	import type { PageData } from './$types';
	import type {
		CreateMissionRequest,
		MissionApprovalPolicy,
		MissionScheduleMode,
		UpdateMissionRequest
	} from '@repo/types';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	let { data }: { data: PageData } = $props();

	const isEdit = $derived(!!data.mission);

	// ── Form state (pre-filled in edit mode) ───────────────────────────────────
	let title = $state(data.mission?.title ?? '');
	let goal = $state(data.mission?.goal ?? '');
	let scheduleMode = $state<MissionScheduleMode>(data.mission?.scheduleMode ?? 'agent');
	let cronExpr = $state(data.mission?.cronExpr ?? '');
	let timezone = $state(
		data.mission?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
	);
	// Numeric fields bind to <Input type="number"> — Svelte coerces those bindings
	// to number (or null when the field is cleared), so these are number | null,
	// never strings. Normalized with numberOr()/optionalNumber() on submit.
	let minIntervalMinutes = $state<number | null>(data.mission?.minIntervalMinutes ?? 30);
	let maxIntervalMinutes = $state<number | null>(data.mission?.maxIntervalMinutes ?? 1440);
	let maxCostTotal = $state<number | null>(data.mission?.maxCostTotal ?? 5);
	let maxCostPerDay = $state<number | null>(data.mission?.maxCostPerDay ?? null);
	let maxTurnsPerDay = $state<number | null>(data.mission?.maxTurnsPerDay ?? null);
	let approvalPolicy = $state<MissionApprovalPolicy>(data.mission?.approvalPolicy ?? 'risky');
	let reportChannelLinkId = $state(data.mission?.reportChannelLinkId ?? '');
	let activateNow = $state(false);
	let saving = $state(false);

	const pushableLinks = $derived(
		data.channelLinks.filter(
			(l) => l.isVerified && (l.channel === 'telegram' || l.channel === 'discord')
		)
	);

	const scheduleModeLabel = $derived(
		scheduleMode === 'agent' ? 'Agent-paced (recommended)' : 'Fixed cron schedule'
	);
	const approvalPolicyLabel = $derived(
		approvalPolicy === 'risky'
			? 'Risky actions (recommended)'
			: approvalPolicy === 'always'
				? 'Every outward-facing action'
				: 'Never ask'
	);
	const reportChannelLabel = $derived.by(() => {
		const link = pushableLinks.find((l) => l.id === reportChannelLinkId);
		return link
			? `${link.channel} — ${link.displayName ?? link.externalId}`
			: 'In-app only (default)';
	});

	// ── Submit ──────────────────────────────────────────────────────────────────
	async function handleSave(): Promise<void> {
		if (!title.trim() || !goal.trim()) {
			setAlert({
				type: 'error',
				title: 'Missing fields',
				message: 'Title and goal are required.',
				duration: 5000,
				show: true
			});
			return;
		}
		const total = maxCostTotal;
		if (total === null || !Number.isFinite(total) || total <= 0) {
			setAlert({
				type: 'error',
				title: 'Invalid budget',
				message: 'The total budget must be a positive number.',
				duration: 5000,
				show: true
			});
			return;
		}
		if (scheduleMode === 'fixed' && !cronExpr.trim()) {
			setAlert({
				type: 'error',
				title: 'Missing schedule',
				message: 'A cron expression is required for fixed schedules.',
				duration: 5000,
				show: true
			});
			return;
		}

		const shared = {
			title: title.trim(),
			goal: goal.trim(),
			scheduleMode,
			cronExpr: scheduleMode === 'fixed' ? cronExpr.trim() : undefined,
			timezone: timezone.trim() || undefined,
			minIntervalMinutes: minIntervalMinutes ?? 30,
			maxIntervalMinutes: maxIntervalMinutes ?? 1440,
			maxCostTotal: total,
			approvalPolicy
		};

		// Optional numeric fields: null (cleared) / non-finite → omit; else the number.
		const dailyCost =
			maxCostPerDay !== null && Number.isFinite(maxCostPerDay) && maxCostPerDay > 0
				? maxCostPerDay
				: null;
		const dailyTurns =
			maxTurnsPerDay !== null && Number.isInteger(maxTurnsPerDay) && maxTurnsPerDay > 0
				? maxTurnsPerDay
				: null;

		saving = true;
		try {
			let res: Response;
			if (isEdit && data.mission) {
				const body: UpdateMissionRequest = {
					...shared,
					maxCostPerDay: dailyCost,
					maxTurnsPerDay: dailyTurns,
					reportChannelLinkId: reportChannelLinkId || null
				};
				res = await api(`/agents/${data.agent.id}/missions/${data.mission.id}`, {
					method: 'PUT',
					body: JSON.stringify(body)
				});
			} else {
				const body: CreateMissionRequest = {
					...shared,
					maxCostPerDay: dailyCost ?? undefined,
					maxTurnsPerDay: dailyTurns ?? undefined,
					reportChannelLinkId: reportChannelLinkId || undefined,
					activate: activateNow
				};
				res = await api(`/agents/${data.agent.id}/missions`, {
					method: 'POST',
					body: JSON.stringify(body)
				});
			}
			const json = await res.json();
			if (!res.ok || !json.success) {
				setAlert({
					type: 'error',
					title: 'Save failed',
					message: json.error ?? 'Could not save the mission.',
					duration: 6000,
					show: true
				});
				return;
			}
			const missionId = isEdit && data.mission ? data.mission.id : (json.data.id as string);
			setAlert({
				type: 'success',
				title: isEdit ? 'Mission updated' : 'Mission created',
				message: activateNow && !isEdit ? 'The first wake fires within a minute.' : '',
				duration: 4000,
				show: true
			});
			await goto(`/app/agents/${data.agent.id}/missions/${missionId}`);
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>{isEdit ? 'Edit mission' : 'New mission'} — {data.agent.name} — Valmis</title>
	<meta name="description" content="Configure an autonomous mission for {data.agent.name}." />
</svelte:head>

<PageHeader
	title={isEdit ? 'Edit mission' : 'New mission'}
	description="A long-term goal {data.agent
		.name} pursues autonomously, within hard budgets you set."
>
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

<div class="grid max-w-3xl gap-6">
	<!-- ── Goal ─────────────────────────────────────────────────────────────── -->
	<Card.Root>
		<Card.Header class="pb-3">
			<Card.Title class="text-sm font-medium">Goal</Card.Title>
			<Card.Description class="text-xs"
				>What should the agent work toward? Be specific about the outcome and any hard constraints.</Card.Description
			>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="mission-title">Title</Label>
				<Input id="mission-title" bind:value={title} placeholder="e.g. Promote the XYZ launch" />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="mission-goal">Mission goal</Label>
				<Textarea
					id="mission-goal"
					bind:value={goal}
					class="min-h-32"
					placeholder="Describe the long-term goal, the strategy boundaries, what success looks like, and anything the agent must never do…"
				/>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- ── Schedule ─────────────────────────────────────────────────────────── -->
	<Card.Root>
		<Card.Header class="pb-3">
			<Card.Title class="text-sm font-medium">Schedule</Card.Title>
			<Card.Description class="text-xs"
				>Agent-paced missions pick their own next wake between your bounds; fixed missions wake on a
				cron schedule.</Card.Description
			>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label>Mode</Label>
				<Select.Root type="single" bind:value={scheduleMode}>
					<Select.Trigger class="w-72">{scheduleModeLabel}</Select.Trigger>
					<Select.Content>
						<Select.Item value="agent" label="Agent-paced (recommended)"
							>Agent-paced (recommended)</Select.Item
						>
						<Select.Item value="fixed" label="Fixed cron schedule">Fixed cron schedule</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>
			{#if scheduleMode === 'agent'}
				<div class="grid grid-cols-2 gap-4">
					<div class="flex flex-col gap-2">
						<Label for="min-interval">Minimum interval (minutes)</Label>
						<Input id="min-interval" type="number" min="1" bind:value={minIntervalMinutes} />
					</div>
					<div class="flex flex-col gap-2">
						<Label for="max-interval">Maximum interval (minutes)</Label>
						<Input id="max-interval" type="number" min="1" bind:value={maxIntervalMinutes} />
						<p class="text-xs text-muted-foreground">
							Also the fallback cadence when the agent forgets to schedule.
						</p>
					</div>
				</div>
			{:else}
				<div class="grid grid-cols-2 gap-4">
					<div class="flex flex-col gap-2">
						<Label for="cron-expr">Cron expression</Label>
						<Input id="cron-expr" bind:value={cronExpr} placeholder="0 9 * * 1-5" />
					</div>
					<div class="flex flex-col gap-2">
						<Label for="timezone">Timezone</Label>
						<Input id="timezone" bind:value={timezone} placeholder="UTC" />
					</div>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- ── Budget ───────────────────────────────────────────────────────────── -->
	<Card.Root>
		<Card.Header class="pb-3">
			<Card.Title class="text-sm font-medium">Budget (hard limits)</Card.Title>
			<Card.Description class="text-xs"
				>LLM spend estimates from model-catalog pricing. The mission pauses automatically at the
				total budget; daily limits defer to the next day.</Card.Description
			>
		</Card.Header>
		<Card.Content class="grid grid-cols-1 gap-4 sm:grid-cols-3">
			<div class="flex flex-col gap-2">
				<Label for="budget-total">Total budget (USD) *</Label>
				<Input id="budget-total" type="number" min="0" step="0.5" bind:value={maxCostTotal} />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="budget-daily">Daily cost limit (USD)</Label>
				<Input
					id="budget-daily"
					type="number"
					min="0"
					step="0.5"
					bind:value={maxCostPerDay}
					placeholder="none"
				/>
			</div>
			<div class="flex flex-col gap-2">
				<Label for="budget-turns">Max wakes per day</Label>
				<Input
					id="budget-turns"
					type="number"
					min="1"
					bind:value={maxTurnsPerDay}
					placeholder="none"
				/>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- ── Oversight ────────────────────────────────────────────────────────── -->
	<Card.Root>
		<Card.Header class="pb-3">
			<Card.Title class="text-sm font-medium">Oversight</Card.Title>
			<Card.Description class="text-xs"
				>When the agent must ask you before acting, and where its reports are delivered.</Card.Description
			>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label>Ask for approval before…</Label>
				<Select.Root type="single" bind:value={approvalPolicy}>
					<Select.Trigger class="w-72">{approvalPolicyLabel}</Select.Trigger>
					<Select.Content>
						<Select.Item value="risky" label="Risky actions (recommended)"
							>Risky actions (recommended)</Select.Item
						>
						<Select.Item value="always" label="Every outward-facing action"
							>Every outward-facing action</Select.Item
						>
						<Select.Item value="never" label="Never ask">Never ask</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>
			<div class="flex flex-col gap-2">
				<Label>Report delivery channel</Label>
				<Select.Root type="single" bind:value={reportChannelLinkId}>
					<Select.Trigger class="w-72">{reportChannelLabel}</Select.Trigger>
					<Select.Content>
						<Select.Item value="" label="In-app only (default)">In-app only (default)</Select.Item>
						{#each pushableLinks as link (link.id)}
							<Select.Item
								value={link.id}
								label={`${link.channel} — ${link.displayName ?? link.externalId}`}
							>
								{link.channel} — {link.displayName ?? link.externalId}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				<p class="text-xs text-muted-foreground">
					Reports always appear in-app; a linked Telegram/Discord account also receives a push.
				</p>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- ── Actions ──────────────────────────────────────────────────────────── -->
	<div class="flex items-center justify-between gap-4">
		{#if !isEdit}
			<div class="flex items-center gap-2">
				<Switch id="activate-now" bind:checked={activateNow} />
				<Label for="activate-now" class="text-sm"
					>Activate immediately (first wake within a minute)</Label
				>
			</div>
		{:else}
			<div></div>
		{/if}
		<div class="flex gap-2">
			<Button variant="outline" onclick={() => goto(`/app/agents/${data.agent.id}/missions`)}>
				Cancel
			</Button>
			<Button onclick={handleSave} disabled={saving}>
				{saving
					? 'Saving…'
					: isEdit
						? 'Save changes'
						: activateNow
							? 'Create & activate'
							: 'Create as draft'}
			</Button>
		</div>
	</div>
</div>
