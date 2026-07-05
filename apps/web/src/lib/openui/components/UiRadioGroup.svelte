<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import {
		getFormName,
		getGetFieldValue,
		getIsStreaming,
		getSetFieldValue
	} from '@openuidev/svelte-lang';
	import * as RadioGroup from '$lib/components/ui/radio-group';
	import { Label } from '$lib/components/ui/label';
	import { setupFieldValidation } from '../field-validation.svelte';

	let {
		props
	}: ComponentRenderProps<{
		name: string;
		options?: string[];
		label?: string;
		rules?: string[];
	}> = $props();

	const formName = getFormName();
	const getFieldValue = getGetFieldValue();
	const setFieldValue = getSetFieldValue();
	const isStreaming = getIsStreaming();

	const value = $derived((getFieldValue(formName, props.name) as string | undefined) ?? '');

	const validation = setupFieldValidation(
		() => props.name,
		() => props.rules,
		() => getFieldValue(formName, props.name)
	);

	function handleValueChange(next: string): void {
		setFieldValue(formName, 'RadioGroup', props.name, next, true);
		validation.validateNow(next);
	}
</script>

<div class="flex flex-col gap-1.5">
	{#if props.label}
		<Label>{props.label}</Label>
	{/if}
	<RadioGroup.Root {value} onValueChange={handleValueChange} disabled={isStreaming()}>
		{#each props.options ?? [] as option (option)}
			<div class="flex items-center gap-2">
				<RadioGroup.Item value={option} id="openui-{formName}-{props.name}-{option}" />
				<Label for="openui-{formName}-{props.name}-{option}" class="font-normal">{option}</Label>
			</div>
		{/each}
	</RadioGroup.Root>
	{#if validation.error()}
		<p class="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive" role="alert">
			{validation.error()}
		</p>
	{/if}
</div>
