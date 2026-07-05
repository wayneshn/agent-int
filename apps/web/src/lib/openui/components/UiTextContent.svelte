<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';

	let { props }: ComponentRenderProps<{ text: string; size?: 'small' | 'normal' | 'heading' }> =
		$props();
</script>

{#if props.size === 'heading'}
	<!-- Matches the Card.Title primitive (font-heading = Noto Serif). -->
	<h4 class="font-heading text-base font-medium text-foreground">{props.text}</h4>
{:else if props.size === 'small'}
	<p class="text-xs text-muted-foreground">{props.text}</p>
{:else}
	<p class="text-sm text-foreground">{props.text}</p>
{/if}
