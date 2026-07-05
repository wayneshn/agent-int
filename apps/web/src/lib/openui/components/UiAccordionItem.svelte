<script lang="ts">
	import type { ComponentRenderProps, ElementNode } from '@openuidev/svelte-lang';

	// AccordionItem is normally consumed by UiAccordion via node introspection.
	// Standalone fallback renders the content so nothing silently disappears.
	let { props, renderNode }: ComponentRenderProps<{ title: string; children?: ElementNode[] }> =
		$props();
</script>

<div class="flex flex-col gap-3">
	{@render renderNode(props.children)}
</div>
