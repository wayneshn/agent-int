<script lang="ts">
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { testRun } from '$lib/workflow/test-run.svelte.js';
	import PlayIcon from '@lucide/svelte/icons/play';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import SkipForwardIcon from '@lucide/svelte/icons/skip-forward';

	interface Props {
		/** Canvas node id (=== step log stepId). */
		id: string;
		/** Node kind — drives the result-line formatting and whether the run button is full-run. */
		kind: 'trigger' | 'agent' | 'condition' | 'loop';
	}

	let { id, kind }: Props = $props();

	const log = $derived(testRun.logByNodeId[id]);

	/** Loop nodes surface a "source wasn't a list" warning from the runtime. */
	const loopWarning = $derived.by(() => {
		if (kind !== 'loop') return null;
		const out = (log?.outputData ?? {}) as Record<string, unknown>;
		const inp = (log?.inputContext ?? {}) as Record<string, unknown>;
		const w = out.itemsWarning ?? inp.itemsWarning;
		return typeof w === 'string' ? w : null;
	});

	/** A compact one-line result summary shown on the node after a test run. */
	const resultLine = $derived.by(() => {
		if (!log?.outputData) return null;
		const out = log.outputData as Record<string, unknown>;
		if (kind === 'condition') return typeof out.result === 'boolean' ? String(out.result) : null;
		if (kind === 'loop') {
			const inp = (log.inputContext ?? {}) as Record<string, unknown>;
			const iterations = typeof out.iterations === 'number' ? out.iterations : null;
			const itemCount = typeof inp.itemCount === 'number' ? inp.itemCount : null;
			if (iterations === null) return null;
			// e.g. "4 items · ⟳ 4"  (item count from the resolved source, iterations actually run)
			return itemCount !== null ? `${itemCount} items · ⟳ ${iterations}` : `⟳ ${iterations}`;
		}
		// agent step
		const text = typeof out.text === 'string' ? out.text : JSON.stringify(out);
		return text.length > 80 ? `${text.slice(0, 80)}…` : text;
	});

	function run(e: MouseEvent) {
		e.stopPropagation();
		if (testRun.busy) return;
		// The trigger node runs the whole workflow; other nodes run "up to here".
		testRun.runNode?.(kind === 'trigger' ? undefined : id);
	}
</script>

<!-- ▶ Run button — appears on saved workflows; the node container must be `relative`. -->
{#if testRun.canTest}
	<button
		type="button"
		onclick={run}
		disabled={testRun.busy}
		title={kind === 'trigger' ? 'Test trigger data' : 'Run only this step (test)'}
		aria-label={kind === 'trigger' ? 'Test trigger data' : 'Run only this step'}
		class="nodrag absolute top-1.5 right-1.5 z-10 flex size-5 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
	>
		<PlayIcon class="size-3" />
	</button>
{/if}

<!-- Status footer — shown once this node has a log in the current test run. -->
{#if testRun.active && log}
	<div class="flex items-center gap-1.5 border-t border-border px-3 py-1.5">
		<span
			class="flex size-4 shrink-0 items-center justify-center rounded-full {log.status === 'success'
				? 'text-green-500'
				: log.status === 'failed'
					? 'text-destructive'
					: log.status === 'skipped'
						? 'text-muted-foreground'
						: 'text-primary'}"
		>
			{#if log.status === 'success'}
				<CheckIcon class="size-3.5" />
			{:else if log.status === 'failed'}
				<XIcon class="size-3.5" />
			{:else if log.status === 'skipped'}
				<SkipForwardIcon class="size-3.5" />
			{:else}
				<LoaderIcon class="size-3.5 animate-spin" />
			{/if}
		</span>
		{#if kind === 'condition' && resultLine}
			<Badge
				variant={resultLine === 'true' ? 'secondary' : 'outline'}
				class="text-[10px] capitalize">{resultLine}</Badge
			>
		{:else if resultLine}
			<span
				class="truncate font-mono text-[10px] {loopWarning
					? 'text-amber-600 dark:text-amber-400'
					: 'text-muted-foreground'}"
				title={loopWarning ?? undefined}
			>
				{loopWarning ? '⚠ ' : ''}{resultLine}
			</span>
		{:else}
			<span class="text-[10px] text-muted-foreground capitalize">{log.status}</span>
		{/if}
	</div>
{/if}
