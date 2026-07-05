<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';

	let { props }: ComponentRenderProps<{ text: string; url: string }> = $props();
</script>

<a
	href={props.url}
	target="_blank"
	rel="noopener noreferrer"
	class="w-fit text-sm text-primary underline underline-offset-2 hover:opacity-80"
>
	{props.text}
</a>
