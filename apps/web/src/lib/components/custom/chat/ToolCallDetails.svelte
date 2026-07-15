<script lang="ts">
	import ImageBlock from './ImageBlock.svelte';

	/**
	 * The expandable detail body of a tool call: arguments, result, and any image
	 * results. Shared by ToolCallRow (grouped rail rows) and ToolCallIndicator
	 * (the standalone Form-data strip) so the detail styling stays identical.
	 */
	let {
		argsJson,
		detailsLabel = 'Arguments',
		result,
		images
	}: {
		/** Pretty-printed JSON args the LLM decided to pass — the "thinking context" */
		argsJson?: string;
		/** Heading for the argsJson section — defaults to 'Arguments' */
		detailsLabel?: string;
		/** Raw tool execution output returned to the agent */
		result?: string;
		/** Image content blocks returned by the tool (e.g. a browser screenshot) */
		images?: { data: string; mimeType: string }[];
	} = $props();
</script>

<div class="divide-y divide-border/30">
	{#if argsJson}
		<!-- Arguments — what the agent chose to pass to the tool -->
		<div class="px-3 py-2">
			<p class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground/60 uppercase">
				{detailsLabel}
			</p>
			<pre
				class="overflow-x-auto font-mono text-[11px] leading-relaxed wrap-break-word break-all whitespace-pre-wrap text-muted-foreground/80">{argsJson}</pre>
		</div>
	{/if}

	{#if result}
		<!-- Result — raw tool execution output -->
		<div class="px-3 py-2">
			<p class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground/60 uppercase">
				Result
			</p>
			<pre
				class="overflow-x-auto font-mono text-[11px] leading-relaxed wrap-break-word break-all whitespace-pre-wrap text-muted-foreground/80">{result}</pre>
		</div>
	{/if}

	{#if images && images.length > 0}
		<!-- Image results — e.g. a browser screenshot -->
		<div class="px-3 py-2">
			<p class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground/60 uppercase">
				Image
			</p>
			{#each images as image, i (i)}
				<ImageBlock data={image.data} mimeType={image.mimeType} />
			{/each}
		</div>
	{/if}
</div>
