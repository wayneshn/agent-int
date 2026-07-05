<script lang="ts">
	import type { ComponentRenderProps, ElementNode } from '@openuidev/svelte-lang';

	// TabItem is normally consumed by UiTabs via node introspection and never
	// rendered directly. This standalone fallback (model placed a TabItem
	// outside Tabs) just renders its content so nothing silently disappears.
	let { props, renderNode }: ComponentRenderProps<{ title: string; children?: ElementNode[] }> =
		$props();
</script>

<div class="flex flex-col gap-3">
	{@render renderNode(props.children)}
</div>
