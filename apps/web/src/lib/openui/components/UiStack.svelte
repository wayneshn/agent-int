<script lang="ts">
	import type { ComponentRenderProps, ElementNode } from '@openuidev/svelte-lang';

	let { props, renderNode }: ComponentRenderProps<{ children?: ElementNode[] }> = $props();
</script>

<div class="flex flex-col gap-4">
	{@render renderNode(props.children)}
</div>
