<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import { Badge } from '$lib/components/ui/badge';

	let {
		props
	}: ComponentRenderProps<{
		text: string;
		variant?: 'default' | 'secondary' | 'destructive' | 'outline';
	}> = $props();
</script>

<Badge variant={props.variant ?? 'default'} class="w-fit">{props.text}</Badge>
