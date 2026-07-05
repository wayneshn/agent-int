<script lang="ts">
	import type { ComponentRenderProps } from '@openuidev/svelte-lang';
	import hljs from 'highlight.js';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CheckIcon from '@lucide/svelte/icons/check';

	let { props }: ComponentRenderProps<{ code: string; language?: string }> = $props();

	let copied = $state(false);

	const highlighted = $derived.by(() => {
		const lang =
			props.language && hljs.getLanguage(props.language)
				? props.language
				: (hljs.highlightAuto(props.code ?? '').language ?? 'plaintext');
		return { language: lang, html: hljs.highlight(props.code ?? '', { language: lang }).value };
	});

	async function copy(): Promise<void> {
		await navigator.clipboard.writeText(props.code ?? '');
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="openui-code group relative w-full">
	<div
		class="flex items-center justify-between rounded-t-md border border-b-0 border-border bg-muted/60 px-3 py-1.5"
	>
		<span class="text-[10px] tracking-wide text-muted-foreground uppercase">
			{highlighted.language}
		</span>
		<button
			type="button"
			class="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
			onclick={copy}
			aria-label="Copy code"
		>
			{#if copied}
				<CheckIcon class="size-3" /> Copied
			{:else}
				<CopyIcon class="size-3" /> Copy
			{/if}
		</button>
	</div>
	<pre class="overflow-x-auto rounded-b-md border border-border"><code class="hljs"
			>{@html highlighted.html}</code
		></pre>
</div>

<style>
	/* Same hljs themes as MarkdownRenderer — Vite dedupes the imports. */
	@import 'highlight.js/styles/github.css';
	@import 'highlight.js/styles/github-dark-dimmed.css' layer(hljs-dark);

	.openui-code pre {
		background-color: #f6f8fa;
		font-size: 0.8125rem;
		line-height: 1.6;
		margin: 0;
	}

	.openui-code pre code.hljs {
		display: block;
		padding: 0.875rem 1rem;
		background: transparent;
		font-size: inherit;
		line-height: inherit;
	}

	:global(.dark) .openui-code pre {
		background-color: #22272e;
	}

	:global(.dark) .openui-code pre code.hljs {
		color: var(--hljs-dark-fg, #adbac7);
		background: transparent;
	}
</style>
