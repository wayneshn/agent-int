<script lang="ts">
	import { Renderer, BuiltinActionType } from '@openuidev/svelte-lang';
	import type { ActionEvent, ParseResult } from '@openuidev/svelte-lang';
	import { chatUiLibrary } from '$lib/openui/library';
	import LayoutIcon from '@lucide/svelte/icons/layout-template';

	/**
	 * Renders the OpenUI Lang code emitted by the agent's render_ui tool.
	 * Button clicks and form submits fire continue_conversation actions that are
	 * sent back to the agent as a normal chat message via onSendMessage.
	 */
	let {
		code,
		disabled = false,
		streaming = false,
		onSendMessage
	}: {
		code: string;
		/** True while the agent turn is still streaming — blocks interactions. */
		disabled?: boolean;
		/**
		 * True while the code itself is still arriving (render_ui_partial
		 * snapshots) — renders progressively, disables interactions, and never
		 * shows the parse-fail fallback (incomplete code is expected mid-stream).
		 */
		streaming?: boolean;
		onSendMessage: (text: string) => void;
	} = $props();

	let parseFailed = $state(false);

	function handleParseResult(result: ParseResult | null): void {
		// While the code is still streaming, incomplete parses are expected —
		// the Renderer draws what it can and fills in as lines arrive. Once
		// complete (tool already validated it), a missing root means the
		// persisted code is genuinely unrenderable — show the fallback row.
		parseFailed = !streaming && (result === null || result.root === null);
	}

	/**
	 * Flatten the Renderer's form state ({ formName: { field: { value } } } or
	 * { field: { value } } when unscoped) into { field: value } for the agent.
	 */
	function flattenFormState(
		state: Record<string, unknown> | undefined,
		formName: string | undefined
	): Record<string, unknown> | undefined {
		if (!state) return undefined;
		const bucket = formName && state[formName] ? state[formName] : state;
		if (typeof bucket !== 'object' || bucket === null) return undefined;
		const flat: Record<string, unknown> = {};
		for (const [field, entry] of Object.entries(bucket as Record<string, unknown>)) {
			if (entry && typeof entry === 'object' && 'value' in entry) {
				const { value, componentType } = entry as { value: unknown; componentType?: string };
				// UiCheckbox stores unchecked as '' so the "required" rule can fail
				// (false counts as present) — normalize back to false for the agent.
				flat[field] = componentType === 'Checkbox' && value === '' ? false : value;
			}
		}
		return Object.keys(flat).length > 0 ? flat : undefined;
	}

	function handleAction(event: ActionEvent): void {
		if (disabled) return;
		if (event.type === BuiltinActionType.OpenUrl) {
			const url = typeof event.params.url === 'string' ? event.params.url : '';
			if (url) window.open(url, '_blank', 'noopener,noreferrer');
			return;
		}
		// continue_conversation — button label / submit label, plus form values.
		// Message shape "<label>\n\n```json\n<data>\n```" is a display contract:
		// ChatMessage.parseUserFormMessage splits it back apart to render the
		// data as an expandable strip instead of raw code fences.
		const values = flattenFormState(event.formState, event.formName);
		const text = values
			? `${event.humanFriendlyMessage}\n\n\`\`\`json\n${JSON.stringify(values, null, 2)}\n\`\`\``
			: event.humanFriendlyMessage;
		if (text.trim().length > 0) onSendMessage(text);
	}
</script>

{#if parseFailed}
	<div
		class="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
	>
		<LayoutIcon class="size-3.5" />
		<span>Generated UI — failed to render</span>
	</div>
{:else}
	<!-- No wrapper chrome — Cards/Stats/charts carry their own (avoids double borders). -->
	<div class="w-full py-1">
		<Renderer
			response={code}
			library={chatUiLibrary}
			isStreaming={streaming || disabled}
			onAction={handleAction}
			onParseResult={handleParseResult}
		/>
		{#if streaming}
			<!-- Building indicator while the code is still arriving -->
			<div class="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
				<span class="size-1.5 animate-pulse rounded-full bg-primary"></span>
				<span>Building UI…</span>
			</div>
		{/if}
	</div>
{/if}
