<script lang="ts">
	import type { ComponentRenderProps, ElementNode } from '@openuidev/svelte-lang';

	let { props, renderNode }: ComponentRenderProps<{ buttons?: ElementNode[] }> = $props();
</script>

<div class="flex flex-wrap items-center gap-2">
	{@render renderNode(props.buttons)}
</div>
