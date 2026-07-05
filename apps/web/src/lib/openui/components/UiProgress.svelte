<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import { accentChartVar, type ChatUiAccent } from '@repo/openui';

	let { props }: ComponentRenderProps<{ value: number; label?: string; accent?: ChatUiAccent }> =
		$props();

	const clamped = $derived(Math.min(100, Math.max(0, props.value ?? 0)));
</script>

<div class="flex flex-col gap-1.5">
	{#if props.label}
		<div class="flex items-center justify-between">
			<span class="text-xs text-muted-foreground">{props.label}</span>
			<span class="text-xs text-muted-foreground tabular-nums">{clamped}%</span>
		</div>
	{/if}
	<!-- Matches the shadcn Progress primitive's geometry (h-3 rounded-4xl bg-muted);
	 kept custom so the indicator can take an accent color instead of bg-primary. -->
	<div
		class="h-3 w-full overflow-hidden rounded-4xl bg-muted"
		role="progressbar"
		aria-valuenow={clamped}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-label={props.label}
	>
		<div
			class="h-full rounded-4xl transition-all"
			style="width: {clamped}%; background-color: {accentChartVar(props.accent)}"
		></div>
	</div>
</div>
