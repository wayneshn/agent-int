<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import {
		getFormName,
		getGetFieldValue,
		getIsStreaming,
		getSetFieldValue
	} from '@openuidev/svelte-lang';
	import { Slider } from '$lib/components/ui/slider';
	import { Label } from '$lib/components/ui/label';

	let {
		props
	}: ComponentRenderProps<{
		name: string;
		label?: string;
		min?: number;
		max?: number;
		step?: number;
	}> = $props();

	const formName = getFormName();
	const getFieldValue = getGetFieldValue();
	const setFieldValue = getSetFieldValue();
	const isStreaming = getIsStreaming();

	const min = $derived(props.min ?? 0);
	const max = $derived(props.max ?? 100);

	const stored = $derived(getFieldValue(formName, props.name) as number | undefined);
	const value = $derived(stored ?? min);

	function handleValueChange(next: number): void {
		setFieldValue(formName, 'Slider', props.name, next, true);
	}
</script>

<div class="flex flex-col gap-2">
	<div class="flex items-center justify-between">
		{#if props.label}
			<Label>{props.label}</Label>
		{/if}
		<span class="text-xs text-muted-foreground tabular-nums">{value}</span>
	</div>
	<Slider
		type="single"
		{value}
		{min}
		{max}
		step={props.step ?? 1}
		disabled={isStreaming()}
		onValueChange={handleValueChange}
	/>
</div>
