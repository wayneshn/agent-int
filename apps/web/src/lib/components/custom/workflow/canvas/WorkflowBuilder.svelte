<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy, type Snippet } from 'svelte';
	import { SvelteFlowProvider, type Node, type Edge } from '@xyflow/svelte';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { themeStore } from '$lib/stores/theme.store.js';
	import { api } from '$lib/api.client.js';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte.js';
	import { testRun, resetTestRun } from '$lib/workflow/test-run.svelte.js';
	import WorkflowCanvas from './WorkflowCanvas.svelte';
	import WorkflowNodeConfigSheet from './WorkflowNodeConfigSheet.svelte';
	import WorkflowValidationAlert from './WorkflowValidationAlert.svelte';
	import WorkflowTestDialog from './WorkflowTestDialog.svelte';
	import InfoIcon from '@lucide/svelte/icons/info';
	import PlayIcon from '@lucide/svelte/icons/play';
	import {
		initialDomainGraph,
		domainToFlow,
		flowToDomain,
		type AgentNodeRender,
		type ConditionNodeRender,
		type LoopNodeRender
	} from '$lib/workflow/graph.js';
	import type {
		Agent,
		Workflow,
		WorkflowStep,
		WorkflowAgentNode,
		WorkflowConditionNodeData,
		WorkflowLoopNodeData,
		AgentTriggerKind,
		CredentialMetadata,
		CredentialDefinition,
		AppTriggerProviderInfo,
		AppTriggerRegistrationStatus,
		WorkflowToolCatalog
	} from '@repo/types';

	/**
	 * Visual workflow builder: a Svelte Flow canvas (trigger + agent step nodes) plus
	 * a side-drawer node editor. Owns the graph + trigger state and exposes the
	 * serialized save payload and client-side validation errors to the page.
	 */
	interface Props {
		agent: Agent;
		workflow: Workflow | null;
		credentials: CredentialMetadata[];
		definitions: CredentialDefinition[];
		/** Whether the agent has browser access — gates the "Agent Browser" tool group. */
		browserAvailable?: boolean;
		/** Tool-picker catalog from the server load (values live in @repo/utils). */
		toolCatalog: WorkflowToolCatalog;
		appTriggerProviders: AppTriggerProviderInfo[];
		/** Serialized workflow JSON for the page's hidden form input. */
		payload: string;
		/** Client-side validation problems, surfaced by the page on submit. */
		validationErrors: string[];
		/** Triggered by ⌘S / Ctrl+S while the canvas is focused — the page submits the form. */
		onRequestSave?: () => void;
		/** Save/Cancel buttons, rendered floating in the canvas's top-right corner. */
		actions?: Snippet;
		/** Toggled true by the page on a save attempt with errors; shows the validation alert. */
		showValidationErrors: boolean;
	}

	let {
		agent,
		workflow,
		credentials,
		definitions,
		browserAvailable = false,
		toolCatalog,
		appTriggerProviders,
		payload = $bindable(''),
		validationErrors = $bindable([]),
		onRequestSave,
		actions,
		showValidationErrors = $bindable(false)
	}: Props = $props();

	// ── Identity ────────────────────────────────────────────────────────────────
	let workflowName = $state(workflow?.name ?? '');
	let workflowDescription = $state(workflow?.description ?? '');

	// ── Trigger state (the trigger is a separate entity; node is UI only) ─────────
	let triggerKind = $state<AgentTriggerKind>(
		(workflow?.trigger?.kind as AgentTriggerKind | undefined) ?? 'manual'
	);
	let cronSchedule = $state<string>(
		workflow?.trigger?.kind === 'cron'
			? ((workflow.trigger.config as { schedule?: string } | undefined)?.schedule ?? '0 9 * * *')
			: '0 9 * * *'
	);
	let cronTimezone = $state<string>(
		workflow?.trigger?.kind === 'cron'
			? ((workflow.trigger.config as { timezone?: string } | undefined)?.timezone ?? 'UTC')
			: 'UTC'
	);
	let webhookRequireSignature = $state<boolean>(
		workflow?.trigger?.kind === 'webhook'
			? ((workflow.trigger.config as { requireSignature?: boolean } | undefined)
					?.requireSignature ?? true)
			: true
	);
	const appConfig = $derived(
		workflow?.trigger?.kind === 'app'
			? (workflow.trigger.config as {
					provider?: string;
					event?: string;
					credentialId?: string;
					params?: Record<string, unknown>;
					pollIntervalSec?: number;
				})
			: undefined
	);
	let appProvider = $state<string>(
		(workflow?.trigger?.kind === 'app'
			? (workflow.trigger.config as { provider?: string }).provider
			: undefined) ??
			appTriggerProviders[0]?.id ??
			''
	);
	let appEvent = $state<string>(
		(workflow?.trigger?.kind === 'app'
			? (workflow.trigger.config as { event?: string }).event
			: undefined) ??
			appTriggerProviders[0]?.events[0]?.id ??
			''
	);
	let appCredentialId = $state<string>(
		workflow?.trigger?.kind === 'app'
			? ((workflow.trigger.config as { credentialId?: string }).credentialId ?? '')
			: ''
	);
	let appParams = $state<Record<string, unknown>>(
		workflow?.trigger?.kind === 'app'
			? ((workflow.trigger.config as { params?: Record<string, unknown> }).params ?? {})
			: {}
	);
	let appPollIntervalSec = $state<number | undefined>(
		workflow?.trigger?.kind === 'app'
			? (workflow.trigger.config as { pollIntervalSec?: number }).pollIntervalSec
			: undefined
	);

	const webhookSecret = $derived(
		triggerKind === 'webhook' && workflow?.trigger?.kind === 'webhook'
			? ((workflow.trigger.config as { secret?: string } | undefined)?.secret ?? null)
			: null
	);
	const webhookUrl = $derived(
		workflow?.trigger
			? `${browser ? window.location.origin : ''}/api/v1/webhooks/${workflow.trigger.id}`
			: null
	);
	const appRegistration = $derived<AppTriggerRegistrationStatus | undefined>(
		workflow?.trigger?.kind === 'app' ? workflow.trigger.appRegistration : undefined
	);

	// ── Graph state (Svelte Flow render model) ────────────────────────────────────
	const seed = initialDomainGraph(workflow);
	const seedFlow = domainToFlow(seed.nodes, seed.edges, triggerKind);
	let nodes = $state.raw<Node[]>(seedFlow.nodes);
	let edges = $state.raw<Edge[]>(seedFlow.edges);

	// Keep the trigger node's badge in sync with the selected trigger kind.
	$effect(() => {
		const kind = triggerKind;
		const trig = nodes.find((n) => n.type === 'trigger');
		if (trig && (trig.data as { kind?: string }).kind !== kind) {
			nodes = nodes.map((n) => (n.type === 'trigger' ? { ...n, data: { ...n.data, kind } } : n));
		}
	});

	// ── Selection / Sheet ─────────────────────────────────────────────────────────
	let selectedNodeId = $state<string | null>(null);
	const selectedNode = $derived(nodes.find((n) => n.id === selectedNodeId) ?? null);
	const selectedNodeType = $derived(
		(selectedNode?.type as 'trigger' | 'agent' | 'condition' | 'loop' | undefined) ?? null
	);
	const selectedStep = $derived(
		selectedNode?.type === 'agent' ? (selectedNode.data as AgentNodeRender).step : null
	);
	const selectedCondition = $derived(
		selectedNode?.type === 'condition' ? (selectedNode.data as ConditionNodeRender).condition : null
	);
	const selectedLoop = $derived(
		selectedNode?.type === 'loop' ? (selectedNode.data as LoopNodeRender).loop : null
	);

	function onSelect(nodeId: string | null) {
		selectedNodeId = nodeId;
	}

	// Commit handlers — called by the config Sheet only when the user clicks Save.
	function onSaveStep(updated: WorkflowStep) {
		nodes = nodes.map((n) =>
			n.type === 'agent' && n.id === updated.id ? { ...n, data: { step: updated } } : n
		);
	}

	function onSaveCondition(updated: WorkflowConditionNodeData) {
		if (!selectedNodeId) return;
		nodes = nodes.map((n) =>
			n.type === 'condition' && n.id === selectedNodeId ? { ...n, data: { condition: updated } } : n
		);
	}

	function onSaveLoop(updated: WorkflowLoopNodeData) {
		if (!selectedNodeId) return;
		nodes = nodes.map((n) =>
			n.type === 'loop' && n.id === selectedNodeId ? { ...n, data: { loop: updated } } : n
		);
	}

	function onSaveTrigger(t: {
		kind: AgentTriggerKind;
		cronSchedule: string;
		cronTimezone: string;
		webhookRequireSignature: boolean;
		appProvider: string;
		appEvent: string;
		appCredentialId: string;
		appParams: Record<string, unknown>;
		appPollIntervalSec: number | undefined;
	}) {
		triggerKind = t.kind;
		cronSchedule = t.cronSchedule;
		cronTimezone = t.cronTimezone;
		webhookRequireSignature = t.webhookRequireSignature;
		appProvider = t.appProvider;
		appEvent = t.appEvent;
		appCredentialId = t.appCredentialId;
		appParams = t.appParams;
		appPollIntervalSec = t.appPollIntervalSec;
	}

	// ── Serialization → payload (graph is the source of truth) ────────────────────
	const domain = $derived(flowToDomain(nodes, edges));

	const triggerConfig = $derived(
		triggerKind === 'cron'
			? { schedule: cronSchedule.trim(), timezone: cronTimezone.trim() || 'UTC' }
			: triggerKind === 'webhook'
				? { requireSignature: webhookRequireSignature }
				: triggerKind === 'app'
					? {
							provider: appProvider,
							event: appEvent,
							credentialId: appCredentialId,
							params: appParams,
							pollIntervalSec: appPollIntervalSec
						}
					: {}
	);

	$effect(() => {
		payload = JSON.stringify({
			name: workflowName.trim(),
			description: workflowDescription.trim() || undefined,
			nodes: domain.nodes,
			edges: domain.edges,
			isEnabled: workflow?.isEnabled ?? true,
			trigger: {
				kind: triggerKind,
				name: workflowName.trim() || undefined,
				config: triggerConfig,
				description: undefined
			}
		});
	});

	// ── Client-side validation ────────────────────────────────────────────────────
	// Mirrors the server's per-node field rules (validator.ts: workflowStepSchema,
	// conditionNodeDataSchema, loopNodeDataSchema). The server remains authoritative
	// and additionally enforces graph-structure invariants (unique ids, one trigger,
	// edge integrity, acyclic-except-loopBack) that aren't re-checked here.
	const computedErrors = $derived.by(() => {
		const errs: string[] = [];
		if (!workflowName.trim()) errs.push('Workflow name is required');
		const agentNodes = domain.nodes.filter((n) => n.type === 'agent') as WorkflowAgentNode[];
		if (agentNodes.length === 0) errs.push('Workflow must have at least one step');
		agentNodes.forEach((n, i) => {
			if (!n.data.name.trim()) errs.push(`Step ${i + 1} → name is required`);
			if (!n.data.instruction.trim()) errs.push(`Step ${i + 1} → instruction is required`);
		});

		// Condition nodes: name required; Manual mode needs ≥1 rule, Smart mode needs a prompt.
		for (const n of domain.nodes) {
			if (n.type !== 'condition') continue;
			const d = n.data as WorkflowConditionNodeData;
			const label = d.name?.trim() || 'Condition';
			if (!d.name?.trim()) errs.push(`${label} → name is required`);
			const mode = d.evalMode ?? 'smart';
			if (mode === 'manual') {
				if (!d.filter || d.filter.conditions.length === 0)
					errs.push(`${label} → add at least one rule (or switch to Smart mode)`);
			} else if (!d.prompt || !d.prompt.trim()) {
				errs.push(`${label} → describe the condition for the agent to evaluate`);
			}
		}

		// Loop nodes: name required; a while-loop needs a continue-condition (rule or prompt).
		for (const n of domain.nodes) {
			if (n.type !== 'loop') continue;
			const d = n.data as WorkflowLoopNodeData;
			const label = d.name?.trim() || 'Loop';
			if (!d.name?.trim()) errs.push(`${label} → name is required`);
			if (d.mode === 'while') {
				const mode = d.evalMode ?? 'smart';
				if (mode === 'manual') {
					if (!d.condition || d.condition.conditions.length === 0)
						errs.push(`${label} → add at least one rule (or switch to Smart mode)`);
				} else if (!d.prompt || !d.prompt.trim()) {
					errs.push(`${label} → describe when the loop should continue`);
				}
			}
		}

		if (triggerKind === 'cron' && !cronSchedule.trim()) errs.push('Cron schedule is required');
		if (triggerKind === 'app') {
			if (!appProvider) errs.push('App trigger: choose an app');
			if (!appEvent) errs.push('App trigger: choose an event');
			if (!appCredentialId) errs.push('App trigger: choose a credential');
			const provider = appTriggerProviders.find((p) => p.id === appProvider);
			const ev = provider?.events.find((e) => e.id === appEvent);
			for (const field of ev?.params ?? []) {
				if (!field.required) continue;
				const value = appParams[field.name];
				const isEmpty =
					value === undefined ||
					value === null ||
					value === '' ||
					(Array.isArray(value) && value.length === 0);
				if (isEmpty) errs.push(`App trigger: "${field.label}" is required`);
			}
		}
		// Dedupe: nodes left at their defaults (e.g. two unconfigured "Condition" nodes)
		// produce identical messages — collapse them so the list never repeats a line.
		return [...new Set(errs)];
	});

	// `validationErrors` is computed live (the page reads it to gate submit), but the
	// floating alert only appears after a save attempt sets `showValidationErrors`.
	// Once every problem is resolved we reset the flag, so it never reappears on a
	// fresh edit without another save click.
	$effect(() => {
		validationErrors = computedErrors;
		if (computedErrors.length === 0) showValidationErrors = false;
	});

	// ── Keyboard: ⌘S / Ctrl+S saves the workflow while the canvas is focused ──────
	// SvelteFlow handles keys at the document level, so the canvas doesn't reliably
	// own DOM focus. We instead track whether the user's last pointer/focus landed
	// inside the canvas region and only intercept the shortcut while it's active.
	let canvasEl = $state<HTMLDivElement | null>(null);

	$effect(() => {
		let active = false;
		const within = (t: EventTarget | null): boolean =>
			t instanceof Node && !!canvasEl && canvasEl.contains(t);
		const onPointerDown = (e: PointerEvent) => {
			active = within(e.target);
		};
		const onFocusIn = (e: FocusEvent) => {
			active = within(e.target);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's') return;
			if (!active) return;
			e.preventDefault();
			onRequestSave?.();
		};
		window.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('focusin', onFocusIn, true);
		window.addEventListener('keydown', onKeyDown, true);
		return () => {
			window.removeEventListener('pointerdown', onPointerDown, true);
			window.removeEventListener('focusin', onFocusIn, true);
			window.removeEventListener('keydown', onKeyDown, true);
		};
	});

	// ── Test mode ─────────────────────────────────────────────────────────────────
	// A test run is a real run seeded with a chosen trigger payload. It requires a SAVED,
	// unmodified workflow so canvas node ids match the persisted step ids the run logs against.
	import type { WorkflowRun, WorkflowStepLog } from '@repo/types';

	const agentId = $derived(agent.id);
	const workflowId = $derived(workflow?.id ?? null);
	const triggerId = $derived(workflow?.trigger?.id ?? null);

	// Test requires a SAVED workflow (canvas node ids must match persisted step ids). It runs the
	// saved server-side definition, so unsaved canvas moves are irrelevant — no dirty gate (a
	// snapshot gate previously drifted on Svelte Flow position changes and wrongly disabled re-test).
	const canTest = $derived(!!workflowId && !!triggerId);

	let testDialogOpen = $state(false);
	// What the payload dialog does on confirm: run the whole workflow, preview the trigger data
	// only (no run), or run a single step.
	type TestAction = 'full' | 'trigger' | { node: string };
	let pendingAction = $state<TestAction>('full');
	let currentRun = $state<{ id: string; mode: 'full' | 'single' } | null>(null);

	const triggerNodeId = $derived(domain.nodes.find((n) => n.type === 'trigger')?.id ?? null);
	const dialogMode = $derived(
		pendingAction === 'trigger' ? 'trigger' : pendingAction === 'full' ? 'full' : 'single'
	);

	/** Display name of a node in the live graph (for dependency messages). */
	function nodeName(id: string): string {
		const n = domain.nodes.find((x) => x.id === id);
		if (!n) return 'a previous step';
		if (n.type === 'agent') return n.data.name || 'Step';
		if (n.type === 'condition') return n.data.name || 'Condition';
		if (n.type === 'loop') return n.data.name || 'Loop';
		return 'Trigger';
	}

	/** Upstream sources (trigger + transitive ancestors) the selected loop can iterate.
	 *  Walks incoming edges backwards, excluding the loop's own body feedback (loopBack)
	 *  so body nodes are never offered as an items source. */
	const loopSources = $derived.by(() => {
		if (selectedNodeType !== 'loop' || !selectedNodeId) return [];
		const ancestors = new Set<string>();
		const queue = [selectedNodeId];
		while (queue.length > 0) {
			const cur = queue.shift()!;
			for (const e of domain.edges) {
				if (e.target !== cur || e.targetHandle === 'loopBack') continue;
				if (e.source !== selectedNodeId && !ancestors.has(e.source)) {
					ancestors.add(e.source);
					queue.push(e.source);
				}
			}
		}
		return domain.nodes
			.filter((n) => ancestors.has(n.id))
			.map((n) => ({
				id: n.id,
				name: nodeName(n.id),
				kind: n.type as 'trigger' | 'agent' | 'condition' | 'loop'
			}));
	});

	/** A non-trigger predecessor of `nodeId` with no successful output yet, or null. */
	function unmetDependency(nodeId: string): string | null {
		const triggerNode = domain.nodes.find((n) => n.type === 'trigger');
		for (const e of domain.edges) {
			if (e.target !== nodeId || e.targetHandle === 'loopBack') continue;
			if (triggerNode && e.source === triggerNode.id) continue;
			const log = testRun.logByNodeId[e.source];
			if (!log || log.status !== 'success') return nodeName(e.source);
		}
		return null;
	}

	/** Prior-run outputs keyed by node id, to seed a single-node test. */
	function seededOutputs(): Record<string, Record<string, unknown>> {
		const out: Record<string, Record<string, unknown>> = {};
		for (const [id, log] of Object.entries(testRun.logByNodeId)) {
			if (log.status === 'success' && log.outputData) out[id] = log.outputData;
		}
		return out;
	}

	function openTestDialog(action: TestAction) {
		if (!canTest) {
			setAlert({
				type: 'warning',
				title: 'Save before testing',
				message: 'Save the workflow first — Test runs the saved version.',
				duration: 5000,
				show: true
			});
			return;
		}
		pendingAction = action;
		testDialogOpen = true;
	}

	// Dialog confirm — dispatch by the pending action.
	function onDialogConfirm(payload: Record<string, unknown>) {
		testDialogOpen = false;
		if (pendingAction === 'trigger') {
			// Testing the trigger ONLY sets/previews its data — it does not run any steps. The
			// payload also seeds later single-step tests.
			testRun.seedPayload = payload;
			testRun.active = true;
			return;
		}
		if (pendingAction === 'full') {
			void startRun(payload, {});
			return;
		}
		void startRun(payload, { testNodeId: pendingAction.node });
	}

	async function startRun(payload: Record<string, unknown>, opts: { testNodeId?: string } = {}) {
		if (!workflowId) return;
		const mode: 'full' | 'single' = opts.testNodeId ? 'single' : 'full';
		testRun.busy = true;
		try {
			const res = await api(`/agents/${agentId}/workflows/${workflowId}/test-run`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					payload,
					testNodeId: opts.testNodeId,
					seededOutputs: opts.testNodeId ? seededOutputs() : undefined
				})
			});
			const body = (await res.json()) as {
				success: boolean;
				data?: { runId: string };
				error?: string;
			};
			if (!res.ok || !body.success || !body.data) {
				throw new Error(body.error ?? 'Test run failed to start.');
			}
			// Full run clears the overlay; a single-node run KEEPS prior outputs (they seed later
			// steps). The poller then merges (single) or replaces (full) the per-node logs.
			if (mode === 'full') resetTestRun();
			testRun.seedPayload = payload;
			testRun.active = true;
			testRun.status = 'running';
			currentRun = { id: body.data.runId, mode };
			testDialogOpen = false;
		} catch (err) {
			setAlert({
				type: 'error',
				title: 'Could not start test run',
				message: err instanceof Error ? err.message : 'Please try again.',
				duration: 6000,
				show: true
			});
		} finally {
			testRun.busy = false;
		}
	}

	// Expose the per-node ▶ action + gating to the overlays. The TRIGGER node previews its data
	// only (no run); a STEP runs ONLY itself (guarded on upstream data). The whole workflow runs
	// solely from the top-bar Test button.
	$effect(() => {
		testRun.canTest = canTest;
		testRun.runNode = (nodeId?: string) => {
			if (nodeId === undefined || nodeId === triggerNodeId) {
				openTestDialog('trigger'); // trigger node ▶ → set/preview trigger data, no run
				return;
			}
			const missing = unmetDependency(nodeId);
			if (missing) {
				setAlert({
					type: 'warning',
					title: 'Missing upstream data',
					message: `This step needs data from "${missing}". Run it (or the whole workflow) first.`,
					duration: 6000,
					show: true
				});
				return;
			}
			if (testRun.seedPayload) void startRun(testRun.seedPayload, { testNodeId: nodeId });
			else openTestDialog({ node: nodeId });
		};
	});

	// Live poll — keyed on the run id ONLY (never reads testRun.status, which it also writes), so a
	// new run always restarts polling. Merges (single) or replaces (full) the per-node logs.
	$effect(() => {
		const run = currentRun;
		if (!browser || !run || !workflowId) return;
		const { id: runId, mode } = run;
		let stopped = false;
		let timer: ReturnType<typeof setInterval>;

		async function tick() {
			if (stopped) return;
			const [runRes, stepsRes] = await Promise.all([
				api(`/agents/${agentId}/workflows/${workflowId}/runs/${runId}`),
				api(`/agents/${agentId}/workflows/${workflowId}/runs/${runId}/steps`)
			]);
			if (stepsRes.ok) {
				const body = (await stepsRes.json()) as { data?: WorkflowStepLog[] };
				const reduced: Record<string, WorkflowStepLog> = {};
				for (const log of body.data ?? []) {
					const prev = reduced[log.stepId];
					// Later loop iterations win via a higher stepIndex; within a single execution,
					// retries share the same stepIndex, so tie-break on attemptNumber (>= so the
					// last-seen max attempt wins) — otherwise a retried-then-succeeded step is left
					// showing its first (failed) attempt, which blocks/mis-seeds single-node tests.
					const newer =
						!prev ||
						log.stepIndex > prev.stepIndex ||
						(log.stepIndex === prev.stepIndex && log.attemptNumber >= prev.attemptNumber);
					if (newer) reduced[log.stepId] = log;
				}
				testRun.logByNodeId = mode === 'full' ? reduced : { ...testRun.logByNodeId, ...reduced };
			}
			if (runRes.ok) {
				const body = (await runRes.json()) as { data?: WorkflowRun };
				const status = body.data?.status;
				if (status) {
					testRun.status = status;
					if (status !== 'running') {
						stopped = true;
						clearInterval(timer);
					}
				}
			}
		}

		timer = setInterval(() => void tick().catch(() => {}), 3000);
		void tick();
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	});

	onDestroy(() => {
		resetTestRun();
		testRun.runNode = null;
		testRun.canTest = false;
	});
</script>

<div class="space-y-4">
	<!-- Identity: borderless click-to-edit title + description on one compact line.
	     No labels — the inputs read as text and reveal a subtle surface on hover/focus. -->
	<div class="flex items-baseline gap-2 px-1">
		<input
			bind:value={workflowName}
			required
			aria-label="Workflow name"
			placeholder="Untitled workflow"
			class="w-64 max-w-[40%] flex-none rounded-md bg-transparent px-2 py-1 font-heading text-xl font-semibold tracking-tight transition-colors outline-none placeholder:text-muted-foreground/50 hover:bg-muted/60 focus:bg-muted/80"
		/>
		<span class="text-muted-foreground/40 select-none" aria-hidden="true">/</span>
		<input
			bind:value={workflowDescription}
			aria-label="Workflow description"
			placeholder="Add a description"
			class="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm text-muted-foreground transition-colors outline-none placeholder:text-muted-foreground/50 hover:bg-muted/60 focus:bg-muted/80 focus:text-foreground"
		/>
	</div>

	<!-- Canvas -->
	<div
		bind:this={canvasEl}
		class="relative h-[calc(100dvh-10rem)] min-h-[460px] w-full overflow-hidden rounded-lg border border-border bg-muted/20"
	>
		{#if browser}
			<SvelteFlowProvider>
				<WorkflowCanvas bind:nodes bind:edges colorMode={$themeStore} {onSelect} />
			</SvelteFlowProvider>
		{:else}
			<div class="flex h-full items-center justify-center">
				<p class="text-sm text-muted-foreground">Loading canvas…</p>
			</div>
		{/if}

		<!-- Floating Save/Cancel bar + help. The buttons live in the page's <form>, so the
		     submit button still submits — the positioning here is purely CSS. -->
		<div
			class="absolute top-3 right-3 z-30 flex items-center gap-2 rounded-lg border border-border bg-card/95 p-1.5 shadow-md backdrop-blur"
		>
			<Tooltip.Provider delayDuration={200}>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								type="button"
								variant="ghost"
								size="icon"
								class="size-8 text-muted-foreground"
								aria-label="How to build a workflow"
							>
								<InfoIcon class="size-4" />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content class="max-w-xs">
						<p class="text-xs leading-relaxed">
							Drag <span class="font-medium">Add node</span> onto the canvas (or click it) to add a
							step. Connect nodes by dragging from a node's right handle to the next node's left
							handle. Click any node to configure it. Select an edge or node and press Delete to
							remove it. Press <span class="font-medium">⌘S</span> (Ctrl+S on Windows) to save.
						</p>
					</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>

			<!-- Test the saved workflow with a chosen trigger payload; results overlay on the nodes. -->
			<Tooltip.Provider delayDuration={200}>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								type="button"
								variant="ghost"
								size="sm"
								class="gap-1.5 text-muted-foreground"
								disabled={!canTest || testRun.busy}
								onclick={() => openTestDialog('full')}
							>
								<PlayIcon class="size-4" />
								Test
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content class="max-w-xs">
						<p class="text-xs leading-relaxed">
							{#if canTest}
								Run the workflow with a trigger payload you provide. Each step shows its real input
								and output. Uses your live model and credentials.
							{:else}
								Save the workflow (with no unsaved changes) to test it.
							{/if}
						</p>
					</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>

			{@render actions?.()}
		</div>

		<!-- Floating validation warning — bottom-right, only after a save attempt with problems. -->
		{#if showValidationErrors && validationErrors.length > 0}
			<div class="absolute right-3 bottom-3 z-30">
				<WorkflowValidationAlert
					errors={validationErrors}
					onDismiss={() => (showValidationErrors = false)}
				/>
			</div>
		{/if}
	</div>
</div>

<!-- Node editor drawer -->
<WorkflowNodeConfigSheet
	open={selectedNodeId !== null}
	nodeId={selectedNodeId}
	nodeType={selectedNodeType}
	onClose={() => onSelect(null)}
	step={selectedStep}
	{credentials}
	{definitions}
	{browserAvailable}
	{toolCatalog}
	{onSaveStep}
	condition={selectedCondition}
	loop={selectedLoop}
	{loopSources}
	{onSaveCondition}
	{onSaveLoop}
	{triggerKind}
	{cronSchedule}
	{cronTimezone}
	{webhookRequireSignature}
	{appProvider}
	{appEvent}
	{appCredentialId}
	{appParams}
	{appPollIntervalSec}
	{onSaveTrigger}
	providers={appTriggerProviders}
	{webhookSecret}
	{webhookUrl}
	triggerId={workflow?.trigger?.id ?? null}
	{appRegistration}
/>

<!-- Test-mode payload dialog -->
<WorkflowTestDialog
	open={testDialogOpen}
	mode={dialogMode}
	{triggerKind}
	{appProvider}
	{appEvent}
	{appCredentialId}
	{appParams}
	providers={appTriggerProviders}
	busy={testRun.busy}
	onOpenChange={(o) => (testDialogOpen = o)}
	onConfirm={onDialogConfirm}
/>
