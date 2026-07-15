<script module lang="ts">
	import type WrenchIcon from '@lucide/svelte/icons/wrench';

	/** One tool call's resolved display data, built in ChatMessage. */
	export interface ToolCallRowData {
		id: string;
		toolName: string;
		toolDisplayName?: string;
		argsJson?: string;
		result?: string;
		images?: { data: string; mimeType: string }[];
		isRunning: boolean;
		iconUrl?: string;
		iconComponent?: typeof WrenchIcon;
	}
</script>

<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import ToolCallRow from './ToolCallRow.svelte';

	/**
	 * A round's tool calls rendered as one connected vertical rail: a thin line
	 * runs through the whole group with a small status node per call (spinner while
	 * running → check when done). Each row expands in place to its args/result.
	 */
	let { rows }: { rows: ToolCallRowData[] } = $props();
</script>

<div class="my-1.5 flex flex-col">
	{#each rows as row, i (row.id)}
		<div class="flex gap-2.5">
			<!-- Rail: top connector · status node · bottom connector -->
			<div class="relative flex w-3 shrink-0 flex-col items-center">
				<!-- Top connector (spacer on the first row so the line starts at the node) -->
				<span class="h-2 w-px {i > 0 ? 'bg-border/50' : ''}"></span>
				<!-- Status node -->
				{#if row.isRunning}
					<LoaderCircleIcon class="size-3 shrink-0 animate-spin text-muted-foreground/60" />
				{:else}
					<CheckIcon class="size-3 shrink-0 text-green-500/90" />
				{/if}
				<!-- Bottom connector fills to the next node (omitted on the last row) -->
				{#if i < rows.length - 1}
					<span class="w-px flex-1 bg-border/50"></span>
				{/if}
			</div>

			<!-- Row content -->
			<div class="min-w-0 flex-1 pb-1.5">
				<ToolCallRow
					toolName={row.toolName}
					toolDisplayName={row.toolDisplayName}
					argsJson={row.argsJson}
					result={row.result}
					images={row.images}
					isRunning={row.isRunning}
					iconUrl={row.iconUrl}
					iconComponent={row.iconComponent}
				/>
			</div>
		</div>
	{/each}
</div>
