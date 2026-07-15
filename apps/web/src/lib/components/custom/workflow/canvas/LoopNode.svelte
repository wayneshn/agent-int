<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import type { LoopNodeRender } from '$lib/workflow/graph';
	import { testRun, nodeRingClass } from '$lib/workflow/test-run.svelte.js';
	import NodeTestOverlay from './NodeTestOverlay.svelte';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';

	/** Loop node. Inputs: 'in' (entry) and 'loopBack' (body returns here). Outputs:
	 *  'loop' (body) and 'done' (continue). The body runs once per item / while true. */
	let { id, data, selected }: NodeProps = $props();

	const loop = $derived((data as LoopNodeRender).loop);
	const whileMode = $derived(
		loop.evalMode ??
			(loop.prompt ? 'smart' : loop.condition?.conditions.length ? 'manual' : 'smart')
	);
</script>

<Handle type="target" position={Position.Left} id="in" />
<Handle type="target" position={Position.Top} id="loopBack" />

<!-- 'loop end': the body's LAST node connects back up here (loopBack). Sits above the
     top handle so it doesn't overlap the header. -->
<span
	class="absolute -top-4 left-1/2 -translate-x-1/2 text-[9px] font-medium text-violet-600 dark:text-violet-400"
>
	loop end
</span>

<div
	class="relative w-52 rounded-lg border bg-card shadow-sm transition-colors {selected
		? 'border-primary ring-1 ring-primary'
		: `border-violet-500/50 hover:border-violet-500/70 ${testRun.active ? nodeRingClass(id) : ''}`}"
>
	<div class="flex items-center gap-2 border-b border-border px-3 py-2">
		<div
			class="flex size-6 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-violet-600 dark:text-violet-400"
		>
			<RefreshCwIcon class="size-3.5" />
		</div>
		<span class="w-3/4 truncate text-sm font-medium text-foreground">{loop.name || 'Loop'}</span>
	</div>
	<div class="px-3 py-2 text-xs text-muted-foreground">
		{#if loop.mode === 'forEach'}
			{#if loop.items?.trim()}
				For each item · max {loop.maxIterations}
			{:else}
				<span class="text-amber-600 dark:text-amber-400">For each · (no items source)</span>
			{/if}
		{:else}
			While · {whileMode === 'smart' ? 'Smart' : 'Manual'} · max {loop.maxIterations}
		{/if}
	</div>

	<span class="absolute top-[42%] right-1.5 text-[9px] font-medium text-muted-foreground">done</span
	>

	<NodeTestOverlay {id} kind="loop" />
</div>

<!-- 'loop start': the body's FIRST node connects out from here (loop). Sits below the
     bottom handle, outside the card, mirroring the 'loop end' label. -->
<span
	class="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[9px] font-medium text-violet-600 dark:text-violet-400"
>
	loop start
</span>

<Handle type="source" position={Position.Bottom} id="loop" />
<Handle type="source" position={Position.Right} id="done" style="top: 50%" />
