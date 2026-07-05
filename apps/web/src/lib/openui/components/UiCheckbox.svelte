<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import {
		getFormName,
		getGetFieldValue,
		getIsStreaming,
		getSetFieldValue
	} from '@openuidev/svelte-lang';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import { setupFieldValidation } from '../field-validation.svelte';

	let { props }: ComponentRenderProps<{ name: string; label: string; rules?: string[] }> = $props();

	const formName = getFormName();
	const getFieldValue = getGetFieldValue();
	const setFieldValue = getSetFieldValue();
	const isStreaming = getIsStreaming();

	// Unchecked is stored as '' (not false) so the built-in "required" rule —
	// which treats false as a present value — fails until checked. OpenUiBlock
	// normalizes '' back to false for Checkbox entries before sending.
	const checked = $derived(getFieldValue(formName, props.name) === true);

	const validation = setupFieldValidation(
		() => props.name,
		() => props.rules,
		() => getFieldValue(formName, props.name)
	);

	function handleCheckedChange(next: boolean): void {
		const stored = next ? true : '';
		setFieldValue(formName, 'Checkbox', props.name, stored, true);
		validation.validateNow(stored);
	}
</script>

<div class="flex flex-col gap-1.5">
	<div class="flex items-center gap-2">
		<Checkbox
			id="openui-{formName}-{props.name}"
			{checked}
			disabled={isStreaming()}
			aria-invalid={validation.error() ? true : undefined}
			onCheckedChange={handleCheckedChange}
		/>
		<Label for="openui-{formName}-{props.name}" class="font-normal">{props.label}</Label>
	</div>
	{#if validation.error()}
		<p class="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive" role="alert">
			{validation.error()}
		</p>
	{/if}
</div>
