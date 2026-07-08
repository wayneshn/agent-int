<script lang="ts">
	import { Badge } from '$lib/components/ui/badge/index.js';
	import type { MissionStatus } from '@repo/types';

	let { status }: { status: MissionStatus } = $props();

	const variant = $derived.by((): 'default' | 'secondary' | 'destructive' | 'outline' => {
		switch (status) {
			case 'active':
				return 'default';
			case 'completed':
				return 'secondary';
			case 'failed':
				return 'destructive';
			case 'paused':
			case 'draft':
			default:
				return 'outline';
		}
	});

	const label = $derived(status.charAt(0).toUpperCase() + status.slice(1));
</script>

<Badge {variant}>{label}</Badge>
