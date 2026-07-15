<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import type { ConditionNodeRender } from '$lib/workflow/graph';
	import { testRun, nodeRingClass } from '$lib/workflow/test-run.svelte.js';
	import NodeTestOverlay from './NodeTestOverlay.svelte';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';

	/** Condition node: one input, two outputs ('true' / 'false'). The decision is made
	 *  by the agent (Smart) or by deterministic rules (Manual). */
	let { id, data, selected }: NodeProps = $props();

	const cond = $derived((data as ConditionNodeRender).condition);
	const errorAction = $derived(cond.errorHandling?.action ?? 'stop');
	const ruleCount = $derived(cond.filter?.conditions.length ?? 0);
	const mode = $derived(cond.evalMode ?? (cond.prompt ? 'smart' : ruleCount ? 'manual' : 'smart'));
	const summary = $derived(
		mode === 'smart'
			? cond.prompt?.trim() || 'No condition yet'
			: ruleCount === 0
				? 'No rules yet'
				: `${ruleCount} rule${ruleCount !== 1 ? 's' : ''} (${cond.filter?.combinator})`
	);
</script>

<Handle type="target" position={Position.Left} id="in" />

<div
	class="relative w-52 rounded-lg border bg-card shadow-sm transition-colors {selected
		? 'border-primary ring-1 ring-primary'
		: `border-amber-500/50 hover:border-amber-500/70 ${testRun.active ? nodeRingClass(id) : ''}`}"
>
	<div class="flex items-center gap-2 border-b border-border px-3 py-2">
		<div
			class="flex size-6 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400"
		>
			<GitBranchIcon class="size-3.5" />
		</div>
		<span class="truncate text-sm font-medium text-foreground">{cond.name || 'Condition'}</span>
		{#if errorAction !== 'stop'}
			<Badge variant="secondary" class="ml-auto gap-1 text-[10px] font-normal">
				<ShieldAlertIcon class="size-3" />
				{errorAction}
			</Badge>
		{/if}
	</div>
	<div class="space-y-1 px-3 py-2">
		<span
			class="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-muted-foreground uppercase"
		>
			{mode === 'smart' ? 'Smart' : 'Manual'}
		</span>
		<p class="line-clamp-2 text-xs text-muted-foreground">{summary}</p>
	</div>

	<!-- output markers aligned with the handles -->
	<span
		class="absolute top-[30%] right-1.5 text-[9px] font-medium text-green-600 dark:text-green-400"
	>
		true
	</span>
	<span class="absolute top-[60%] right-1.5 text-[9px] font-medium text-muted-foreground"
		>false</span
	>
	<NodeTestOverlay {id} kind="condition" />
</div>

<Handle type="source" position={Position.Right} id="true" style="top: 35%" />
<Handle type="source" position={Position.Right} id="false" style="top: 65%" />
