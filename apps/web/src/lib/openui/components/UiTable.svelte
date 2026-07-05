<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import * as Table from '$lib/components/ui/table';

	let {
		props
	}: ComponentRenderProps<{
		headers?: string[];
		rows?: (string | number)[][];
		density?: 'comfortable' | 'compact';
	}> = $props();

	const cellClass = $derived(props.density === 'compact' ? 'py-1.5 text-xs' : '');
</script>

<div class="overflow-x-auto rounded-md border border-border">
	<Table.Root>
		<Table.Header>
			<Table.Row>
				{#each props.headers ?? [] as header (header)}
					<Table.Head class={cellClass}>{header}</Table.Head>
				{/each}
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each props.rows ?? [] as row, rowIndex (rowIndex)}
				<Table.Row>
					{#each row as cell, cellIndex (cellIndex)}
						<Table.Cell class={cellClass}>{cell}</Table.Cell>
					{/each}
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</div>
