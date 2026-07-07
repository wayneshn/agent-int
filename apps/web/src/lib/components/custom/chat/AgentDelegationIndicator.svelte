<script lang="ts">
	import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';

	/**
	 * Agent-to-agent delegation indicator.
	 *
	 * Rendered inside the chat message list while the current agent is blocked in an
	 * ask_agent call — i.e. waiting for another agent to finish and reply. Set by the
	 * `agent_delegation` SSE event ('started') and cleared on 'completed'/'error'/'done'.
	 * Uses only theme CSS variables so it adapts to light and dark mode.
	 */
	let {
		targetAgentName,
		targetAgentId,
		targetThreadId
	}: {
		targetAgentName: string;
		targetAgentId: string;
		targetThreadId: string;
	} = $props();
</script>

<!--
	Full-width inline card in the message stream — sits between messages, like the
	HITL prompt, since the wait belongs to the turn rather than to a single bubble.
-->
<div class="mx-4 my-3">
	<div
		class="flex items-center gap-2.5 rounded-lg border border-border bg-card px-4 py-2.5 shadow-sm"
		role="status"
	>
		<MessagesSquareIcon class="size-4 shrink-0 text-muted-foreground" />
		<p class="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
			Waiting for <span class="text-foreground">{targetAgentName}</span> to respond…
		</p>
		<LoaderCircleIcon class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
		<a
			href="/app/chat/{targetAgentId}/{targetThreadId}"
			target="_blank"
			rel="noopener"
			class="shrink-0 text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
		>
			View
		</a>
	</div>
</div>
