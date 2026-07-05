<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';

	let {
		props
	}: ComponentRenderProps<{
		text: string;
		variant?: 'info' | 'success' | 'warning' | 'error';
		title?: string;
	}> = $props();

	// Borderless tinted banners — matches the app's error-banner pattern
	// (rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive).
	const variantClass = $derived.by(() => {
		switch (props.variant) {
			case 'success':
				return 'bg-green-500/10 text-green-700 dark:text-green-400';
			case 'warning':
				return 'bg-amber-500/10 text-amber-700 dark:text-amber-400';
			case 'error':
				return 'bg-destructive/10 text-destructive';
			default:
				return 'bg-muted text-foreground';
		}
	});
</script>

<div role="alert" class="rounded-md px-3 py-2 text-sm {variantClass}">
	{#if props.title}
		<p class="font-semibold">{props.title}</p>
	{/if}
	<p>{props.text}</p>
</div>
