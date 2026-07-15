<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import WorkflowBuilder from '$lib/components/custom/workflow/canvas/WorkflowBuilder.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const isEditMode = $derived(data.isEditMode);
	const agent = $derived(data.agent);
	const workflow = $derived(data.workflow);

	// Bound from the builder: serialized workflow JSON + live validation problems.
	let payload = $state('');
	let validationErrors = $state<string[]>([]);
	// Only flipped true on a save attempt that fails validation — keeps the floating
	// alert hidden until the user actually tries to save.
	let showValidationErrors = $state(false);
	let isSaving = $state(false);

	// The save <form>; ⌘S / Ctrl+S in the canvas submits it through use:enhance.
	let formEl = $state<HTMLFormElement | null>(null);
	function requestSave() {
		if (isSaving) return;
		formEl?.requestSubmit();
	}

	// Show saved alert after redirect
	$effect(() => {
		if ($page.url.searchParams.get('saved') === 'true') {
			setAlert({
				type: 'success',
				title: isEditMode ? 'Workflow updated' : 'Workflow created',
				message: isEditMode
					? 'Your workflow has been saved.'
					: 'Your new workflow has been created.',
				duration: 5000,
				show: true
			});
		}
	});
</script>

<svelte:head>
	{#if isEditMode && workflow}
		<title>{workflow.name} — Edit Workflow — Valmis</title>
		<meta name="description" content="Edit the workflow configuration for {agent.name}." />
	{:else}
		<title>New Workflow — {agent.name} — Valmis</title>
		<meta name="description" content="Create a new automated workflow for {agent.name}." />
	{/if}
</svelte:head>

<!-- Server-side form action handles create and edit -->
<form
	bind:this={formEl}
	method="POST"
	action="?/save"
	use:enhance={({ cancel }) => {
		if (validationErrors.length > 0) {
			cancel();
			// Validation problems surface ONLY in the floating alert, never as a toast.
			showValidationErrors = true;
			return;
		}
		isSaving = true;
		return async ({ result, update }) => {
			isSaving = false;
			if (result.type === 'failure') {
				const failData = result.data as { error?: string; messages?: string[] };
				const messages = failData?.messages ?? (failData?.error ? failData.error.split('\n') : []);
				console.error('[workflow] save failed:', messages.length ? messages : failData?.error);
				setAlert({
					type: 'error',
					title: isEditMode ? 'Failed to save workflow' : 'Failed to create workflow',
					message: messages.join('\n') || failData?.error || 'An unexpected error occurred.',
					duration: 7000,
					show: true
				});
			} else {
				if (result.type === 'redirect') {
					// Follow the 303 redirect WITHOUT resetting scroll, so the canvas stays
					// where the user positioned it (the default navigation jumps to the top).
					await goto(result.location, { noScroll: true, invalidateAll: true });
				} else {
					await update();
				}
			}
		};
	}}
	class="space-y-4"
>
	<!-- Hidden fields populated by the builder -->
	{#if isEditMode && workflow}
		<input type="hidden" name="workflowId" value={workflow.id} />
	{/if}
	<input type="hidden" name="workflowJson" value={payload} />

	<WorkflowBuilder
		{agent}
		{workflow}
		credentials={data.credentials}
		definitions={data.definitions}
		browserAvailable={data.browserAvailable}
		toolCatalog={data.toolCatalog}
		appTriggerProviders={data.appTriggerProviders}
		bind:payload
		bind:validationErrors
		bind:showValidationErrors
		onRequestSave={requestSave}
		{actions}
	/>
</form>

<!-- Rendered inside the canvas's floating top-right bar by WorkflowBuilder. The submit
     button still submits the form above because it stays a DOM descendant of <form>. -->
{#snippet actions()}
	<Button
		type="button"
		variant="outline"
		size="sm"
		onclick={() => goto(`/app/workflows?agentId=${agent.id}`)}
		disabled={isSaving}
	>
		Cancel
	</Button>
	<Button type="submit" size="sm" disabled={isSaving}>
		{#if isSaving}
			{isEditMode ? 'Saving…' : 'Creating…'}
		{:else}
			{isEditMode ? 'Save changes' : 'Create workflow'}
		{/if}
	</Button>
{/snippet}
