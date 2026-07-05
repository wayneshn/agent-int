<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import { getIsStreaming, getTriggerAction } from '@openuidev/svelte-lang';
	import { Button } from '$lib/components/ui/button';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';

	let { props }: ComponentRenderProps<{ suggestions?: string[] }> = $props();

	const triggerAction = getTriggerAction();
	const isStreaming = getIsStreaming();
</script>

<div class="flex flex-wrap items-center gap-2 pt-1">
	{#each props.suggestions ?? [] as suggestion (suggestion)}
		<Button
			variant="outline"
			size="xs"
			class="font-normal text-muted-foreground hover:text-foreground"
			disabled={isStreaming()}
			onclick={() => triggerAction(suggestion)}
		>
			<SparklesIcon class="size-3 opacity-60" />
			{suggestion}
		</Button>
	{/each}
</div>
