<script lang="ts">
	import type { ComponentRenderProps, ElementNode } from '@openuidev/svelte-lang';
	import * as Tabs from '$lib/components/ui/tabs';
	import { isElementNode, nodeProp } from '../node-utils';

	let { props, renderNode }: ComponentRenderProps<{ tabs?: ElementNode[] }> = $props();

	// Introspect the TabItem nodes: shadcn Tabs needs the trigger titles grouped
	// in a List, so the parent reads each item's title/children off the node
	// (mirroring RenderNode's positional mapping: title = arg 0, children = arg 1).
	const items = $derived(
		(props.tabs ?? []).filter(isElementNode).map((node, i) => ({
			value: `tab-${i}`,
			title: nodeProp<string>(node, 'title', 0) ?? `Tab ${i + 1}`,
			children: nodeProp<ElementNode[]>(node, 'children', 1) ?? []
		}))
	);
</script>

{#if items.length > 0}
	<Tabs.Root value="tab-0" class="w-full">
		<Tabs.List>
			{#each items as item (item.value)}
				<Tabs.Trigger value={item.value}>{item.title}</Tabs.Trigger>
			{/each}
		</Tabs.List>
		{#each items as item (item.value)}
			<Tabs.Content value={item.value} class="flex flex-col gap-3 pt-3">
				{@render renderNode(item.children)}
			</Tabs.Content>
		{/each}
	</Tabs.Root>
{/if}
