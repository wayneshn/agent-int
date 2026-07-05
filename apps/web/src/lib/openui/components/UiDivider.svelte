<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import { Separator } from '$lib/components/ui/separator';

	let { props }: ComponentRenderProps<{ label?: string }> = $props();
</script>

{#if props.label}
	<div class="flex items-center gap-3" role="separator">
		<div class="h-px flex-1 bg-border"></div>
		<span class="text-xs text-muted-foreground">{props.label}</span>
		<div class="h-px flex-1 bg-border"></div>
	</div>
{:else}
	<Separator />
{/if}
