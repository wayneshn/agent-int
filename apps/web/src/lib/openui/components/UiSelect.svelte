<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import {
		getFormName,
		getGetFieldValue,
		getIsStreaming,
		getSetFieldValue
	} from '@openuidev/svelte-lang';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { setupFieldValidation } from '../field-validation.svelte';

	let {
		props
	}: ComponentRenderProps<{
		name: string;
		options?: string[];
		label?: string;
		placeholder?: string;
		rules?: string[];
	}> = $props();

	const formName = getFormName();
	const getFieldValue = getGetFieldValue();
	const setFieldValue = getSetFieldValue();
	const isStreaming = getIsStreaming();

	const value = $derived((getFieldValue(formName, props.name) as string | undefined) ?? '');
	const triggerLabel = $derived(value || (props.placeholder ?? 'Select…'));

	const validation = setupFieldValidation(
		() => props.name,
		() => props.rules,
		() => getFieldValue(formName, props.name)
	);

	function handleValueChange(next: string): void {
		// Discrete inputs always persist immediately.
		setFieldValue(formName, 'Select', props.name, next, true);
		validation.validateNow(next);
	}
</script>

<div class="flex flex-col gap-1.5">
	{#if props.label}
		<Label>{props.label}</Label>
	{/if}
	<Select.Root type="single" {value} onValueChange={handleValueChange} disabled={isStreaming()}>
		<Select.Trigger class="w-full" aria-invalid={validation.error() ? true : undefined}>
			{triggerLabel}
		</Select.Trigger>
		<Select.Content>
			{#each props.options ?? [] as option (option)}
				<Select.Item value={option}>{option}</Select.Item>
			{/each}
		</Select.Content>
	</Select.Root>
	{#if validation.error()}
		<p class="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive" role="alert">
			{validation.error()}
		</p>
	{/if}
</div>
