<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import { getIsStreaming, getTriggerAction } from '@openuidev/svelte-lang';
	import { Button } from '$lib/components/ui/button';

	let {
		props
	}: ComponentRenderProps<{
		label: string;
		message?: string;
		variant?: 'default' | 'outline' | 'destructive';
	}> = $props();

	const triggerAction = getTriggerAction();
	const isStreaming = getIsStreaming();
</script>

<Button
	variant={props.variant ?? 'default'}
	size="sm"
	class="w-fit"
	disabled={isStreaming()}
	onclick={() => triggerAction(props.message ?? props.label)}
>
	{props.label}
</Button>
