<script lang="ts">
	import type { ComponentRenderProps, ElementNode } from '@openuidev/svelte-lang';

	let { props, renderNode }: ComponentRenderProps<{ children?: ElementNode[]; columns?: number }> =
		$props();

	const count = $derived.by(() => {
		const requested = props.columns ?? Math.min(props.children?.length ?? 1, 3);
		return Math.min(4, Math.max(2, Math.round(requested)));
	});
</script>

<!-- One column on small screens; the requested grid from sm: up. -->
<div
	class="openui-columns grid grid-cols-1 gap-3"
	style="--openui-columns: repeat({count}, minmax(0, 1fr))"
>
	{#each props.children ?? [] as child, i (i)}
		<div class="flex min-w-0 flex-col gap-3">
			{@render renderNode(child)}
		</div>
	{/each}
</div>

<style>
	@media (min-width: 640px) {
		.openui-columns {
			grid-template-columns: var(--openui-columns);
		}
	}
</style>
