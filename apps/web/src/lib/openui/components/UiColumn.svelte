<script lang="ts">
	import type { ComponentRenderProps, ElementNode } from '@openuidev/svelte-lang';

	let { props, renderNode }: ComponentRenderProps<{ children?: ElementNode[] }> = $props();
</script>

<div class="flex min-w-0 flex-col gap-3">
	{@render renderNode(props.children)}
</div>
