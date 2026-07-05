<script lang="ts">
	import type { ComponentRenderProps, ElementNode } from '@openuidev/svelte-lang';
	import {
		createFormValidation,
		getIsStreaming,
		getTriggerAction,
		setFormNameContext,
		setFormValidationContext
	} from '@openuidev/svelte-lang';
	import { Button } from '$lib/components/ui/button';

	let {
		props,
		renderNode
	}: ComponentRenderProps<{ name: string; children?: ElementNode[]; submitLabel?: string }> =
		$props();

	// Scope child fields (Input/Select/Textarea/…) to this form's state bucket.
	// Context must be set during init; a later name change is not re-scoped.
	setFormNameContext(props.name);

	// Per-form validation context — fields with rules register themselves.
	const validation = createFormValidation();
	setFormValidationContext(validation);

	const triggerAction = getTriggerAction();
	const isStreaming = getIsStreaming();

	function handleSubmit(event: SubmitEvent): void {
		event.preventDefault();
		// Invalid fields populate validation.errors reactively and block submit.
		if (!validation.validateForm()) return;
		// Passing the form name makes the Renderer attach this form's field
		// values to the ActionEvent (event.formState).
		triggerAction(props.submitLabel ?? 'Submit', props.name);
	}
</script>

<form class="flex flex-col gap-4" onsubmit={handleSubmit} novalidate>
	{@render renderNode(props.children)}
	<Button type="submit" size="sm" class="w-fit" disabled={isStreaming()}>
		{props.submitLabel ?? 'Submit'}
	</Button>
</form>
