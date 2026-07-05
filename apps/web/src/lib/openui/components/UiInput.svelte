<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import {
		getFormName,
		getGetFieldValue,
		getIsStreaming,
		getSetFieldValue
	} from '@openuidev/svelte-lang';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { setupFieldValidation } from '../field-validation.svelte';

	let {
		props
	}: ComponentRenderProps<{
		name: string;
		label?: string;
		placeholder?: string;
		type?: 'text' | 'email' | 'number' | 'date';
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

	function handleInput(event: Event): void {
		const target = event.currentTarget as HTMLInputElement;
		// Text inputs persist on blur (shouldTriggerSaveCallback=false on change).
		setFieldValue(formName, 'Input', props.name, target.value, false);
		validation.clearError();
	}

	function handleBlur(event: Event): void {
		const target = event.currentTarget as HTMLInputElement;
		setFieldValue(formName, 'Input', props.name, target.value, true);
		validation.validateNow(target.value);
	}
</script>

<div class="flex flex-col gap-1.5">
	{#if props.label}
		<Label for="openui-{formName}-{props.name}">{props.label}</Label>
	{/if}
	<Input
		id="openui-{formName}-{props.name}"
		type={props.type ?? 'text'}
		name={props.name}
		placeholder={props.placeholder}
		{value}
		disabled={isStreaming()}
		aria-invalid={validation.error() ? true : undefined}
		oninput={handleInput}
		onblur={handleBlur}
	/>
	{#if validation.error()}
		<p class="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive" role="alert">
			{validation.error()}
		</p>
	{/if}
</div>
