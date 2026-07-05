<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import { Badge } from '$lib/components/ui/badge';

	let {
		props
	}: ComponentRenderProps<{
		items?: { title: string; subtitle?: string; badge?: string }[];
	}> = $props();
</script>

<div class="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
	{#each props.items ?? [] as item, i (i)}
		<div class="flex items-center justify-between gap-3 px-3 py-2.5">
			<div class="flex min-w-0 flex-col">
				<span class="truncate text-sm font-medium text-foreground">{item.title}</span>
				{#if item.subtitle}
					<span class="truncate text-xs text-muted-foreground">{item.subtitle}</span>
				{/if}
			</div>
			{#if item.badge}
				<Badge variant="secondary" class="shrink-0">{item.badge}</Badge>
			{/if}
		</div>
	{/each}
</div>
