<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import type { TriggerNodeRender } from '$lib/workflow/graph';
	import NodeTestOverlay from './NodeTestOverlay.svelte';
	import PlayIcon from '@lucide/svelte/icons/play';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import WebhookIcon from '@lucide/svelte/icons/webhook';
	import BlocksIcon from '@lucide/svelte/icons/blocks';

	/** Entry node for the workflow. Its real config lives on workflow.trigger; this
	 *  node is a visual anchor whose `data.kind` drives the badge/icon. */
	let { id, data, selected }: NodeProps = $props();

	const kind = $derived((data as TriggerNodeRender).kind ?? 'manual');

	const meta = $derived(
		kind === 'cron'
			? { icon: ClockIcon, label: 'Scheduled', hint: 'Cron' }
			: kind === 'webhook'
				? { icon: WebhookIcon, label: 'Webhook', hint: 'HTTP request' }
				: kind === 'app'
					? { icon: BlocksIcon, label: 'App event', hint: 'Gmail, Notion…' }
					: { icon: PlayIcon, label: 'Manual', hint: 'On demand' }
	);
</script>

<div
	class="relative w-52 rounded-lg border-2 bg-card shadow-sm transition-colors {selected
		? 'border-primary ring-1 ring-primary'
		: 'border-primary/40 hover:border-primary/60'}"
>
	<div class="flex items-center gap-2 px-3 py-2.5">
		<div
			class="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
		>
			<meta.icon class="size-4" />
		</div>
		<div class="min-w-0">
			<p class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Trigger</p>
			<p class="truncate text-sm font-medium text-foreground">{meta.label}</p>
		</div>
	</div>

	<NodeTestOverlay {id} kind="trigger" />
</div>

<!-- Trigger has only an output handle (it is the entry point) -->
<Handle type="source" position={Position.Right} id="out" />
