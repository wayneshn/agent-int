<script lang="ts" module>
	/** An upstream node the loop can iterate the output of. */
	export interface LoopSource {
		id: string;
		name: string;
		kind: 'trigger' | 'agent' | 'condition' | 'loop';
	}
</script>

<script lang="ts">
	import * as Select from '$lib/components/ui/select/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import FilterBuilder from './FilterBuilder.svelte';
	import { testRun } from '$lib/workflow/test-run.svelte.js';
	import type { WorkflowLoopNodeData, WorkflowEvalMode, FilterValue } from '@repo/types';

	/** Config form for a loop node. forEach iterates over an array template; while
	 *  repeats until a condition is false. The while-condition is evaluated either by
	 *  the agent (Smart) or by deterministic rules (Manual). The body runs from the
	 *  'loop' output and must connect back to the loop's loop-back input. */
	interface Props {
		loop: WorkflowLoopNodeData;
		/** Upstream nodes (trigger + ancestors) whose output can be looped over. */
		sources?: LoopSource[];
		onChange: (data: WorkflowLoopNodeData) => void;
	}

	let { loop, sources = [], onChange }: Props = $props();

	// Stored as consts so the Svelte parser doesn't treat {{ }} as expressions.
	const VAR_ITEM = '{{loop.item}}';
	const VAR_INDEX = '{{loop.index}}';
	const WHILE_PROMPT_HINT =
		"Describe when the loop should keep going. Each iteration the agent reads the latest body output and decides, e.g. 'the list still has fewer than 3 items'.";

	/** Sentinel Select value for the trigger source (its ref is {{trigger.payload}}). */
	const TRIGGER_ID = '__trigger__';

	// ── Parse an existing `items` template back into { source, path } for the picker ──
	// Matches {{trigger.payload}} / {{trigger.payload.a.b}} and
	// {{steps.<id>.output}} / {{steps.<id>.output.a.b}}. Anything else → Advanced mode.
	const TRIGGER_RE = /^\s*\{\{\s*trigger\.payload(?:\.([\w.]+))?\s*\}\}\s*$/;
	const STEP_RE = /^\s*\{\{\s*steps\.([\w-]+)\.output(?:\.([\w.]+))?\s*\}\}\s*$/;

	function parseItems(raw: string): { sourceId: string; path: string; advanced: boolean } {
		const t = (raw ?? '').trim();
		if (!t) return { sourceId: '', path: '', advanced: false };
		const trig = t.match(TRIGGER_RE);
		if (trig) return { sourceId: TRIGGER_ID, path: trig[1] ?? '', advanced: false };
		const step = t.match(STEP_RE);
		if (step) {
			const id = step[1];
			// Only use the guided picker when the referenced node is actually upstream.
			const known = sources.some((s) => s.id === id);
			if (known) return { sourceId: id, path: step[2] ?? '', advanced: false };
		}
		return { sourceId: '', path: '', advanced: true };
	}

	const initial = parseItems(loop.items ?? '');

	let name = $state(loop.name);
	let mode = $state<'forEach' | 'while'>(loop.mode);
	let evalMode = $state<WorkflowEvalMode>(loop.evalMode ?? 'smart');
	let prompt = $state(loop.prompt ?? '');
	let conditionFilter = $state<FilterValue>(
		loop.condition ?? { combinator: 'and', conditions: [] }
	);
	let maxIterations = $state(loop.maxIterations ?? 10);

	// forEach items — guided (source + field path) or Advanced (raw template).
	let sourceId = $state(initial.sourceId);
	let fieldPath = $state(initial.path);
	let advanced = $state(initial.advanced);
	let rawItems = $state(loop.items ?? '');

	/** The trigger source, if it's in the upstream list. */
	const triggerSource = $derived(sources.find((s) => s.kind === 'trigger'));
	const stepSources = $derived(sources.filter((s) => s.kind !== 'trigger'));

	const selectedSourceLabel = $derived.by(() => {
		if (!sourceId) return 'Select a source…';
		if (sourceId === TRIGGER_ID) return 'Trigger payload';
		return sources.find((s) => s.id === sourceId)?.name ?? 'Unknown source';
	});

	/** Compose the `items` template from the guided picker (or raw text in Advanced). */
	function composeItems(): string {
		if (advanced) return rawItems;
		if (!sourceId) return '';
		const base = sourceId === TRIGGER_ID ? 'trigger.payload' : `steps.${sourceId}.output`;
		const suffix = fieldPath.trim() ? `.${fieldPath.trim()}` : '';
		return `{{${base}${suffix}}}`;
	}

	function emit() {
		onChange({
			name,
			mode,
			items: mode === 'forEach' ? composeItems() : undefined,
			evalMode,
			prompt,
			condition: conditionFilter,
			maxIterations
		});
	}

	// ── Live item-count preview from the latest test run ─────────────────────────
	function walkPath(value: unknown, segments: string[]): unknown {
		let cur: unknown = value;
		for (const seg of segments) {
			if (cur === null || typeof cur !== 'object') return undefined;
			cur = (cur as Record<string, unknown>)[seg];
		}
		return cur;
	}

	type Preview =
		| { kind: 'array'; count: number }
		| { kind: 'notlist' }
		| { kind: 'missing' }
		| { kind: 'none' }
		| null;

	const preview = $derived.by((): Preview => {
		if (mode !== 'forEach' || advanced || !sourceId) return null;
		const base =
			sourceId === TRIGGER_ID
				? testRun.seedPayload
				: (testRun.logByNodeId[sourceId]?.outputData ?? null);
		if (base == null) return { kind: 'none' };
		const segs = fieldPath.trim() ? fieldPath.trim().split('.').filter(Boolean) : [];
		const val = walkPath(base, segs);
		if (Array.isArray(val)) return { kind: 'array', count: val.length };
		if (val && typeof val === 'object') {
			// Mirror the runtime: a wrapper object with exactly one array prop unwraps.
			const arrs = Object.values(val).filter(Array.isArray);
			if (arrs.length === 1) return { kind: 'array', count: (arrs[0] as unknown[]).length };
			return { kind: 'notlist' };
		}
		if (val === undefined) return { kind: 'missing' };
		return { kind: 'notlist' };
	});

	function toggleAdvanced() {
		if (advanced) {
			// Leaving Advanced: try to parse the raw template back into the picker.
			const p = parseItems(rawItems);
			sourceId = p.sourceId;
			fieldPath = p.path;
			advanced = false;
		} else {
			// Entering Advanced: seed the textarea with the currently composed template.
			rawItems = composeItems();
			advanced = true;
		}
		emit();
	}
</script>

<div class="space-y-4">
	<div class="space-y-1.5">
		<Label for="loop-name">Name</Label>
		<Input
			id="loop-name"
			type="text"
			bind:value={name}
			oninput={emit}
			placeholder="e.g. For each item"
		/>
	</div>

	<div class="space-y-1.5">
		<Label>Loop type</Label>
		<Select.Root
			type="single"
			value={mode}
			onValueChange={(v) => {
				if (v === 'forEach' || v === 'while') {
					mode = v;
					emit();
				}
			}}
		>
			<Select.Trigger class="w-full">
				{mode === 'forEach' ? 'For each item' : 'While condition'}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="forEach">For each item</Select.Item>
				<Select.Item value="while">While condition</Select.Item>
			</Select.Content>
		</Select.Root>
	</div>

	{#if mode === 'forEach'}
		{#if advanced}
			<div class="space-y-1.5">
				<div class="flex items-center justify-between">
					<Label for="loop-items">Items (template)</Label>
					<button
						type="button"
						class="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
						onclick={toggleAdvanced}
					>
						Use guided picker
					</button>
				</div>
				<textarea
					id="loop-items"
					bind:value={rawItems}
					oninput={emit}
					placeholder={VAR_ITEM}
					rows={2}
					class="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
				></textarea>
				<p class="text-xs text-muted-foreground">
					A template resolving to a JSON array. Inside the body, use
					<code class="rounded bg-muted px-1 py-0.5">{VAR_ITEM}</code> and
					<code class="rounded bg-muted px-1 py-0.5">{VAR_INDEX}</code>.
				</p>
			</div>
		{:else}
			<div class="space-y-1.5">
				<div class="flex items-center justify-between">
					<Label>Loop over</Label>
					<button
						type="button"
						class="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
						onclick={toggleAdvanced}
					>
						Advanced
					</button>
				</div>
				<Select.Root
					type="single"
					value={sourceId}
					onValueChange={(v) => {
						sourceId = v ?? '';
						emit();
					}}
				>
					<Select.Trigger class="w-full">{selectedSourceLabel}</Select.Trigger>
					<Select.Content>
						{#if triggerSource}
							<Select.Item value={TRIGGER_ID}>Trigger payload</Select.Item>
						{/if}
						{#each stepSources as s (s.id)}
							<Select.Item value={s.id}>{s.name}</Select.Item>
						{/each}
						{#if !triggerSource && stepSources.length === 0}
							<div class="px-2 py-1.5 text-xs text-muted-foreground">
								No upstream steps yet — connect a step before this loop.
							</div>
						{/if}
					</Select.Content>
				</Select.Root>
				<p class="text-xs text-muted-foreground">
					The step whose output holds the list. Pick the array field below if the output is an
					object.
				</p>
			</div>

			{#if sourceId}
				<div class="space-y-1.5">
					<Label for="loop-field">Array field <span class="text-muted-foreground">(optional)</span></Label>
					<Input
						id="loop-field"
						type="text"
						bind:value={fieldPath}
						oninput={emit}
						placeholder="e.g. messages or data.items"
						class="font-mono text-xs"
					/>
					<!-- Live preview of how many items the source resolves to (after a test run). -->
					{#if preview?.kind === 'array'}
						<p class="text-xs font-medium text-green-600 dark:text-green-400">
							✓ {preview.count} item{preview.count === 1 ? '' : 's'} — the body runs once per item.
						</p>
					{:else if preview?.kind === 'notlist'}
						<p class="text-xs font-medium text-amber-600 dark:text-amber-400">
							⚠ Not a list. Point the array field at the list inside this output.
						</p>
					{:else if preview?.kind === 'missing'}
						<p class="text-xs font-medium text-amber-600 dark:text-amber-400">
							⚠ That field wasn't found in the source's output.
						</p>
					{:else if preview?.kind === 'none'}
						<p class="text-xs text-muted-foreground">
							Run a test to preview how many items this loops over.
						</p>
					{/if}
					<p class="text-xs text-muted-foreground">
						Inside the body, use <code class="rounded bg-muted px-1 py-0.5">{VAR_ITEM}</code> and
						<code class="rounded bg-muted px-1 py-0.5">{VAR_INDEX}</code>.
					</p>
				</div>
			{/if}
		{/if}
	{:else}
		<div class="space-y-1.5">
			<Label>Continue while</Label>
			<Select.Root
				type="single"
				value={evalMode}
				onValueChange={(v) => {
					if (v === 'smart' || v === 'manual') {
						evalMode = v;
						emit();
					}
				}}
			>
				<Select.Trigger class="w-full">
					{evalMode === 'smart' ? 'Smart — the agent decides' : 'Manual — field rules'}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="smart">Smart — the agent decides</Select.Item>
					<Select.Item value="manual">Manual — field rules</Select.Item>
				</Select.Content>
			</Select.Root>
		</div>

		{#if evalMode === 'smart'}
			<div class="space-y-1.5">
				<Label for="loop-prompt">Keep going while…</Label>
				<textarea
					id="loop-prompt"
					bind:value={prompt}
					oninput={emit}
					placeholder="e.g. the list still has fewer than 3 items"
					rows={3}
					class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
				></textarea>
				<p class="text-xs text-muted-foreground">{WHILE_PROMPT_HINT}</p>
			</div>
		{:else}
			<div class="space-y-1.5">
				<Label>Rules</Label>
				<FilterBuilder
					filter={conditionFilter}
					onChange={(f) => {
						conditionFilter = f;
						emit();
					}}
				/>
			</div>
		{/if}
	{/if}

	<div class="space-y-1.5">
		<Label for="loop-max">Max iterations</Label>
		<Input
			id="loop-max"
			type="number"
			min={1}
			max={1000}
			bind:value={maxIterations}
			oninput={emit}
			class="w-28"
		/>
		<p class="text-xs text-muted-foreground">Safety cap to prevent runaway loops (1–1000).</p>
	</div>
</div>
