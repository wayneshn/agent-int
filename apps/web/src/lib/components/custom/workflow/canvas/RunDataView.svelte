<script lang="ts">
	import { Badge } from '$lib/components/ui/badge/index.js';
	import type { WorkflowStepLog, WorkflowStepLogStatus } from '@repo/types';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import AlertTriangleIcon from '@lucide/svelte/icons/alert-triangle';

	interface Props {
		/** The step log for the selected node in the current test run (absent for the trigger). */
		log?: WorkflowStepLog;
		/** The seed trigger payload — shown for the trigger node (which has no step log). */
		seedPayload?: Record<string, unknown> | null;
	}

	let { log, seedPayload }: Props = $props();

	function statusVariant(
		status: WorkflowStepLogStatus
	): 'default' | 'secondary' | 'destructive' | 'outline' {
		switch (status) {
			case 'running':
				return 'default';
			case 'success':
				return 'secondary';
			case 'failed':
				return 'destructive';
			case 'skipped':
				return 'outline';
		}
	}

	/** Prefer the fully-resolved input the LLM received; fall back to the raw input context. */
	const inputValue = $derived.by(() => {
		const ctx = log?.inputContext as Record<string, unknown> | undefined;
		if (ctx && typeof ctx.resolvedInput === 'string' && ctx.resolvedInput.trim()) {
			return ctx.resolvedInput;
		}
		return ctx ? JSON.stringify(ctx, null, 2) : null;
	});
	const outputValue = $derived(log?.outputData ? JSON.stringify(log.outputData, null, 2) : null);
	const payloadValue = $derived(seedPayload ? JSON.stringify(seedPayload, null, 2) : null);

	let showInput = $state(true);
	let showOutput = $state(true);
	let showPayload = $state(true);
</script>

<div class="mb-4 space-y-2 rounded-md border border-border bg-muted/30 p-3">
	<div class="flex items-center justify-between">
		<span class="text-xs font-medium text-foreground">Run data</span>
		{#if log}
			<Badge variant={statusVariant(log.status)} class="text-[10px] capitalize">{log.status}</Badge>
		{/if}
	</div>

	{#if log?.error}
		<div
			class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5"
		>
			<AlertTriangleIcon class="mt-0.5 size-3.5 shrink-0 text-destructive" />
			<p class="text-xs text-destructive">{log.error}</p>
		</div>
	{/if}

	{#if payloadValue}
		<div>
			<button
				type="button"
				onclick={() => (showPayload = !showPayload)}
				class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
			>
				<ChevronRightIcon class="size-3.5 transition-transform {showPayload ? 'rotate-90' : ''}" />
				Trigger payload
			</button>
			{#if showPayload}
				<pre
					class="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-background px-2.5 py-1.5 text-[11px] text-muted-foreground">{payloadValue}</pre>
			{/if}
		</div>
	{/if}

	{#if inputValue}
		<div>
			<button
				type="button"
				onclick={() => (showInput = !showInput)}
				class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
			>
				<ChevronRightIcon class="size-3.5 transition-transform {showInput ? 'rotate-90' : ''}" />
				Input
			</button>
			{#if showInput}
				<pre
					class="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-background px-2.5 py-1.5 text-[11px] whitespace-pre-wrap text-muted-foreground">{inputValue}</pre>
			{/if}
		</div>
	{/if}

	{#if outputValue}
		<div>
			<button
				type="button"
				onclick={() => (showOutput = !showOutput)}
				class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
			>
				<ChevronRightIcon class="size-3.5 transition-transform {showOutput ? 'rotate-90' : ''}" />
				Output
			</button>
			{#if showOutput}
				<pre
					class="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-background px-2.5 py-1.5 text-[11px] text-muted-foreground">{outputValue}</pre>
			{/if}
		</div>
	{/if}

	{#if !inputValue && !outputValue && !payloadValue}
		<p class="text-xs text-muted-foreground">This node hasn't produced data in the test run yet.</p>
	{/if}
</div>
