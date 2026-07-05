<script lang="ts">
	import type { ComponentRenderProps, ElementNode } from '@openuidev/svelte-lang';
	import * as Accordion from '$lib/components/ui/accordion';
	import { isElementNode, nodeProp } from '../node-utils';

	let { props, renderNode }: ComponentRenderProps<{ items?: ElementNode[] }> = $props();

	// Same node-introspection pattern as UiTabs (title = arg 0, children = arg 1).
	const items = $derived(
		(props.items ?? []).filter(isElementNode).map((node, i) => ({
			value: `item-${i}`,
			title: nodeProp<string>(node, 'title', 0) ?? `Section ${i + 1}`,
			children: nodeProp<ElementNode[]>(node, 'children', 1) ?? []
		}))
	);
</script>

{#if items.length > 0}
	<Accordion.Root type="single" class="w-full rounded-2xl bg-card px-4 ring-1 ring-foreground/10">
		{#each items as item (item.value)}
			<Accordion.Item value={item.value}>
				<Accordion.Trigger class="text-sm">{item.title}</Accordion.Trigger>
				<Accordion.Content class="flex flex-col gap-3">
					{@render renderNode(item.children)}
				</Accordion.Content>
			</Accordion.Item>
		{/each}
	</Accordion.Root>
{/if}
