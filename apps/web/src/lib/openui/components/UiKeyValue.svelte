<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';

	let { props }: ComponentRenderProps<{ pairs?: { label: string; value: string | number }[] }> =
		$props();
</script>

<dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
	{#each props.pairs ?? [] as pair (pair.label)}
		<dt class="text-muted-foreground">{pair.label}</dt>
		<dd class="text-foreground">{pair.value}</dd>
	{/each}
</dl>
