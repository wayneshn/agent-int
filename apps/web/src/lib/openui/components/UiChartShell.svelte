<script lang="ts">
	import type { Snippet } from 'svelte';

	/** Shared chrome for all chart components: card shell + title + plot slot. */
	let { title, children }: { title?: string; children: Snippet } = $props();
</script>

<div class="w-full rounded-2xl bg-card p-4 ring-1 ring-foreground/10">
	{#if title}
		<h4 class="mb-3 text-sm font-medium text-foreground">{title}</h4>
	{/if}
	{@render children()}
</div>
