<script lang="ts">
	import type { ComponentRenderProps, ElementNode } from '@openuidev/svelte-lang';
	import { accentChartVar, type ChatUiAccent } from '@repo/openui';
	import * as Card from '$lib/components/ui/card';

	let {
		props,
		renderNode
	}: ComponentRenderProps<{
		children?: ElementNode[];
		title?: string;
		accent?: ChatUiAccent;
	}> = $props();
</script>

<Card.Root
	size="sm"
	class={props.accent ? 'border-l-2' : ''}
	style={props.accent ? `border-left-color: ${accentChartVar(props.accent)}` : undefined}
>
	{#if props.title}
		<Card.Header>
			<Card.Title class="text-sm font-medium">{props.title}</Card.Title>
		</Card.Header>
	{/if}
	<Card.Content class="flex flex-col gap-3">
		{@render renderNode(props.children)}
	</Card.Content>
</Card.Root>
