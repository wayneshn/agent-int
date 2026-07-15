<script lang="ts">
	import { untrack } from 'svelte';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import WorkflowStepConfigForm from '../WorkflowStepConfigForm.svelte';
	import TriggerConfigPanel from './TriggerConfigPanel.svelte';
	import ConditionConfigForm from './ConditionConfigForm.svelte';
	import LoopConfigForm, { type LoopSource } from './LoopConfigForm.svelte';
	import RunDataView from './RunDataView.svelte';
	import { testRun } from '$lib/workflow/test-run.svelte.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import type {
		WorkflowNodeType,
		WorkflowStep,
		WorkflowConditionNodeData,
		WorkflowLoopNodeData,
		AgentTriggerKind,
		CredentialMetadata,
		CredentialDefinition,
		AppTriggerProviderInfo,
		AppTriggerRegistrationStatus,
		WorkflowToolCatalog
	} from '@repo/types';

	/** The committed trigger fields the Save button hands back to the builder. */
	export interface TriggerDraft {
		kind: AgentTriggerKind;
		cronSchedule: string;
		cronTimezone: string;
		webhookRequireSignature: boolean;
		appProvider: string;
		appEvent: string;
		appCredentialId: string;
		appParams: Record<string, unknown>;
		appPollIntervalSec: number | undefined;
	}

	/**
	 * Right-side drawer that edits the selected node. Edits are drafted locally and only
	 * applied when the user clicks Save; Cancel (or closing the sheet) discards them.
	 */
	interface Props {
		open: boolean;
		nodeId: string | null;
		nodeType: WorkflowNodeType | null;
		onClose: () => void;
		// Agent step
		step: WorkflowStep | null;
		credentials: CredentialMetadata[];
		definitions: CredentialDefinition[];
		/** Whether the agent has browser access — gates the "Agent Browser" tool group. */
		browserAvailable?: boolean;
		/** Tool-picker catalog from the server load (values live in @repo/utils). */
		toolCatalog: WorkflowToolCatalog;
		onSaveStep: (step: WorkflowStep) => void;
		// Condition / loop
		condition: WorkflowConditionNodeData | null;
		loop: WorkflowLoopNodeData | null;
		/** Upstream nodes (trigger + ancestors) offered as the loop's items source. */
		loopSources?: LoopSource[];
		onSaveCondition: (data: WorkflowConditionNodeData) => void;
		onSaveLoop: (data: WorkflowLoopNodeData) => void;
		// Trigger (seed values — drafted internally, committed via onSaveTrigger)
		triggerKind: AgentTriggerKind;
		cronSchedule: string;
		cronTimezone: string;
		webhookRequireSignature: boolean;
		appProvider: string;
		appEvent: string;
		appCredentialId: string;
		appParams: Record<string, unknown>;
		appPollIntervalSec: number | undefined;
		onSaveTrigger: (draft: TriggerDraft) => void;
		providers: AppTriggerProviderInfo[];
		webhookSecret: string | null;
		webhookUrl: string | null;
		triggerId: string | null;
		appRegistration?: AppTriggerRegistrationStatus;
	}

	let {
		open,
		nodeId,
		nodeType,
		onClose,
		step,
		credentials,
		definitions,
		browserAvailable = false,
		toolCatalog,
		onSaveStep,
		condition,
		loop,
		loopSources = [],
		onSaveCondition,
		onSaveLoop,
		triggerKind,
		cronSchedule,
		cronTimezone,
		webhookRequireSignature,
		appProvider,
		appEvent,
		appCredentialId,
		appParams,
		appPollIntervalSec,
		onSaveTrigger,
		providers,
		webhookSecret,
		webhookUrl,
		triggerId,
		appRegistration
	}: Props = $props();

	// ── Draft state — seeded each time a different node is opened ────────────────
	// Step/condition/loop drafts stay null until the form emits a change; on Save we
	// commit `draft ?? committed` so an unedited Save is a no-op.
	let pendingStep = $state<WorkflowStep | null>(null);
	let pendingCondition = $state<WorkflowConditionNodeData | null>(null);
	let pendingLoop = $state<WorkflowLoopNodeData | null>(null);
	// Trigger fields are drafted live (TriggerConfigPanel binds to them).
	let dTriggerKind = $state<AgentTriggerKind>('manual');
	let dCronSchedule = $state('');
	let dCronTimezone = $state('UTC');
	let dWebhookRequireSignature = $state(true);
	let dAppProvider = $state('');
	let dAppEvent = $state('');
	let dAppCredentialId = $state('');
	let dAppParams = $state<Record<string, unknown>>({});
	let dAppPollIntervalSec = $state<number | undefined>(undefined);

	$effect(() => {
		nodeId; // re-seed whenever the selected node changes
		untrack(() => {
			pendingStep = null;
			pendingCondition = null;
			pendingLoop = null;
			dTriggerKind = triggerKind;
			dCronSchedule = cronSchedule;
			dCronTimezone = cronTimezone;
			dWebhookRequireSignature = webhookRequireSignature;
			dAppProvider = appProvider;
			dAppEvent = appEvent;
			dAppCredentialId = appCredentialId;
			dAppParams = structuredClone($state.snapshot(appParams)) as Record<string, unknown>;
			dAppPollIntervalSec = appPollIntervalSec;
		});
	});

	function save() {
		if (nodeType === 'agent') {
			const s = pendingStep ?? step;
			if (s) onSaveStep(s);
		} else if (nodeType === 'condition') {
			const c = pendingCondition ?? condition;
			if (c) onSaveCondition(c);
		} else if (nodeType === 'loop') {
			const l = pendingLoop ?? loop;
			if (l) onSaveLoop(l);
		} else if (nodeType === 'trigger') {
			onSaveTrigger({
				kind: dTriggerKind,
				cronSchedule: dCronSchedule,
				cronTimezone: dCronTimezone,
				webhookRequireSignature: dWebhookRequireSignature,
				appProvider: dAppProvider,
				appEvent: dAppEvent,
				appCredentialId: dAppCredentialId,
				appParams: dAppParams,
				appPollIntervalSec: dAppPollIntervalSec
			});
		}
		onClose();
	}

	const title = $derived(
		nodeType === 'trigger'
			? 'Configure trigger'
			: nodeType === 'condition'
				? 'Configure condition'
				: nodeType === 'loop'
					? 'Configure loop'
					: nodeType === 'agent'
						? 'Configure step'
						: 'Configure node'
	);
	const description = $derived(
		nodeType === 'trigger'
			? 'How this workflow is started.'
			: nodeType === 'condition'
				? 'Branch the flow based on a rule.'
				: nodeType === 'loop'
					? 'Repeat a set of steps over items or while a condition holds.'
					: 'Define what the agent does in this step.'
	);

	// A copyable reference to this node's output, for use in downstream nodes.
	const outputRef = $derived(nodeId ? `{{steps.${nodeId}.output}}` : '');
	const showRef = $derived(nodeType === 'agent' || nodeType === 'condition' || nodeType === 'loop');
	let copied = $state(false);
	function copyRef() {
		if (!outputRef) return;
		navigator.clipboard.writeText(outputRef).then(() => {
			copied = true;
			setTimeout(() => (copied = false), 2000);
		});
	}
</script>

<Sheet.Root
	{open}
	onOpenChange={(o) => {
		if (!o) onClose();
	}}
>
	<Sheet.Content side="right" class="flex flex-col gap-0 p-0 data-[side=right]:sm:max-w-xl">
		<Sheet.Header class="space-y-1 border-b border-border px-6 py-4">
			<Sheet.Title>{title}</Sheet.Title>
			<Sheet.Description>{description}</Sheet.Description>
		</Sheet.Header>

		<div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
			<!-- Test-run data for this node, shown above the config when a test run exists. -->
			{#if testRun.active && nodeId}
				{#if nodeType === 'trigger'}
					<RunDataView seedPayload={testRun.seedPayload} />
				{:else if testRun.logByNodeId[nodeId]}
					<RunDataView log={testRun.logByNodeId[nodeId]} />
				{/if}
			{/if}
			{#if showRef}
				<div
					class="mb-4 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5"
				>
					<span class="shrink-0 text-xs text-muted-foreground">Output ref</span>
					<code class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{outputRef}</code>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onclick={copyRef}
						class="h-7 shrink-0 gap-1 px-2 text-xs"
						title="Copy this node's output reference"
					>
						<CopyIcon class="size-3.5" />
						{copied ? 'Copied' : 'Copy'}
					</Button>
				</div>
			{/if}
			{#if nodeType === 'agent' && step}
				{#key nodeId}
					<WorkflowStepConfigForm
						{step}
						{credentials}
						{definitions}
						{browserAvailable}
						{toolCatalog}
						onChange={(s) => (pendingStep = s)}
					/>
				{/key}
			{:else if nodeType === 'condition' && condition}
				{#key nodeId}
					<ConditionConfigForm {condition} onChange={(d) => (pendingCondition = d)} />
				{/key}
			{:else if nodeType === 'loop' && loop}
				{#key nodeId}
					<LoopConfigForm {loop} sources={loopSources} onChange={(d) => (pendingLoop = d)} />
				{/key}
			{:else if nodeType === 'trigger'}
				<TriggerConfigPanel
					bind:triggerKind={dTriggerKind}
					bind:cronSchedule={dCronSchedule}
					bind:cronTimezone={dCronTimezone}
					bind:webhookRequireSignature={dWebhookRequireSignature}
					bind:appProvider={dAppProvider}
					bind:appEvent={dAppEvent}
					bind:appCredentialId={dAppCredentialId}
					bind:appParams={dAppParams}
					bind:appPollIntervalSec={dAppPollIntervalSec}
					{providers}
					{credentials}
					{webhookSecret}
					{webhookUrl}
					{triggerId}
					{appRegistration}
				/>
			{/if}
		</div>

		<Sheet.Footer class="flex-row justify-end gap-2 border-t border-border px-6 py-4">
			<Button type="button" variant="outline" onclick={onClose}>Cancel</Button>
			<Button type="button" onclick={save}>Save</Button>
		</Sheet.Footer>
	</Sheet.Content>
</Sheet.Root>
