<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import ImageOffIcon from '@lucide/svelte/icons/image-off';

	let { props }: ComponentRenderProps<{ url: string; alt: string; caption?: string }> = $props();

	let failed = $state(false);
</script>

{#if failed}
	<div
		class="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
	>
		<ImageOffIcon class="size-3.5" />
		<span>Image failed to load{props.alt ? ` — ${props.alt}` : ''}</span>
	</div>
{:else}
	<figure class="flex flex-col gap-1.5">
		<img
			src={props.url}
			alt={props.alt}
			loading="lazy"
			referrerpolicy="no-referrer"
			class="max-h-96 w-fit max-w-full rounded-xl border border-border object-contain"
			onerror={() => (failed = true)}
		/>
		{#if props.caption}
			<figcaption class="text-xs text-muted-foreground">{props.caption}</figcaption>
		{/if}
	</figure>
{/if}
