<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import CheckIcon from '@lucide/svelte/icons/check';

	let {
		props
	}: ComponentRenderProps<{
		steps?: { label: string; description?: string; status?: 'done' | 'active' | 'pending' }[];
	}> = $props();
</script>

<ol class="flex flex-col gap-0">
	{#each props.steps ?? [] as step, i (i)}
		{@const status = step.status ?? 'pending'}
		{@const isLast = i === (props.steps?.length ?? 0) - 1}
		<li class="flex gap-3">
			<div class="flex flex-col items-center">
				{#if status === 'done'}
					<span
						class="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
					>
						<CheckIcon class="size-3.5" />
					</span>
				{:else if status === 'active'}
					<span
						class="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-background text-xs font-semibold text-primary"
					>
						{i + 1}
					</span>
				{:else}
					<span
						class="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs text-muted-foreground"
					>
						{i + 1}
					</span>
				{/if}
				{#if !isLast}
					<div class="my-1 w-px flex-1 bg-border" style="min-height: 0.75rem"></div>
				{/if}
			</div>
			<div class="flex flex-col pb-4">
				<span
					class="text-sm {status === 'pending'
						? 'text-muted-foreground'
						: 'font-medium text-foreground'}"
				>
					{step.label}
				</span>
				{#if step.description}
					<span class="text-xs text-muted-foreground">{step.description}</span>
				{/if}
			</div>
		</li>
	{/each}
</ol>
