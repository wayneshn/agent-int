<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import {
		getFormName,
		getGetFieldValue,
		getIsStreaming,
		getSetFieldValue
	} from '@openuidev/svelte-lang';
	import { Switch } from '$lib/components/ui/switch';
	import { Label } from '$lib/components/ui/label';

	let { props }: ComponentRenderProps<{ name: string; label: string }> = $props();

	const formName = getFormName();
	const getFieldValue = getGetFieldValue();
	const setFieldValue = getSetFieldValue();
	const isStreaming = getIsStreaming();

	const checked = $derived(getFieldValue(formName, props.name) === true);

	function handleCheckedChange(next: boolean): void {
		setFieldValue(formName, 'Switch', props.name, next, true);
	}
</script>

<div class="flex items-center gap-2">
	<Switch
		id="openui-{formName}-{props.name}"
		{checked}
		disabled={isStreaming()}
		onCheckedChange={handleCheckedChange}
	/>
	<Label for="openui-{formName}-{props.name}" class="font-normal">{props.label}</Label>
</div>
