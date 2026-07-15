<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { api } from '$lib/api.client.js';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte.js';
	import type {
		AgentTriggerKind,
		AppTriggerProviderInfo,
		AppTriggerSampleResponse
	} from '@repo/types';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import PlayIcon from '@lucide/svelte/icons/play';

	interface Props {
		open: boolean;
		/** full = run whole workflow; trigger = set trigger data only; single = run one step. */
		mode: 'full' | 'trigger' | 'single';
		triggerKind: AgentTriggerKind;
		appProvider: string;
		appEvent: string;
		appCredentialId: string;
		appParams: Record<string, unknown>;
		providers: AppTriggerProviderInfo[];
		/** True while a run is starting (disables the confirm button). */
		busy: boolean;
		/** Called with the parsed payload when the user confirms. */
		onConfirm: (payload: Record<string, unknown>) => void;
		onOpenChange: (open: boolean) => void;
	}

	let {
		open,
		mode,
		triggerKind,
		appProvider,
		appEvent,
		appCredentialId,
		appParams,
		providers,
		busy,
		onConfirm,
		onOpenChange
	}: Props = $props();

	const title = $derived(
		mode === 'trigger' ? 'Test trigger' : mode === 'single' ? 'Run this step' : 'Test workflow'
	);
	const description = $derived(
		mode === 'trigger'
			? 'Provide the trigger data — it seeds tests of individual steps. This does not run any steps.'
			: mode === 'single'
				? 'Runs only this step for real, using data from earlier steps and your live model + credentials.'
				: 'Runs the whole workflow for real — it uses your live model and credentials.'
	);
	const confirmLabel = $derived(mode === 'trigger' ? 'Set data' : 'Run test');

	const provider = $derived(providers.find((p) => p.id === appProvider));
	const event = $derived(provider?.events.find((e) => e.id === appEvent));
	/** Poll providers (Gmail/Outlook/Google Forms) can fetch a real latest item. */
	const canFetchLatest = $derived(triggerKind === 'app' && provider?.deliveryMode === 'poll');

	function defaultPayload(): string {
		if (triggerKind === 'webhook') return '{\n  "headers": {},\n  "body": {}\n}';
		return '{}';
	}

	let jsonText = $state(defaultPayload());
	let jsonError = $state<string | null>(null);
	let fetching = $state(false);

	// Re-seed the editor whenever the dialog (re)opens for a different trigger kind.
	$effect(() => {
		if (open) {
			jsonText = defaultPayload();
			jsonError = null;
		}
	});

	async function fetchLatest() {
		if (!appCredentialId) {
			setAlert({
				type: 'warning',
				title: 'Pick a credential first',
				message: 'Select a credential on the trigger before fetching a sample.',
				duration: 5000,
				show: true
			});
			return;
		}
		fetching = true;
		try {
			const res = await api(`/app-triggers/${appProvider}/sample`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ credentialId: appCredentialId, event: appEvent, params: appParams })
			});
			const body = (await res.json()) as AppTriggerSampleResponse;
			if (!res.ok || !body.success) {
				throw new Error(body.success ? 'Fetch failed' : (body.error ?? 'Fetch failed'));
			}
			if (!body.data) {
				setAlert({
					type: 'warning',
					title: 'Nothing to sample',
					message: 'No recent items found in the connected account.',
					duration: 5000,
					show: true
				});
				return;
			}
			jsonText = JSON.stringify(body.data.payload, null, 2);
			jsonError = null;
		} catch (err) {
			setAlert({
				type: 'error',
				title: 'Could not fetch latest',
				message: err instanceof Error ? err.message : 'Please try again.',
				duration: 6000,
				show: true
			});
		} finally {
			fetching = false;
		}
	}

	function confirm() {
		let parsed: unknown;
		try {
			parsed = jsonText.trim() === '' ? {} : JSON.parse(jsonText);
		} catch {
			jsonError = 'Invalid JSON — check for trailing commas or unquoted keys.';
			return;
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			jsonError = 'The payload must be a JSON object.';
			return;
		}
		jsonError = null;
		onConfirm(parsed as Record<string, unknown>);
	}
</script>

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>{description}</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-3">
			<div class="flex items-center justify-between gap-2">
				<Label for="test-payload">Trigger payload (JSON)</Label>
				{#if canFetchLatest}
					<Button
						type="button"
						variant="outline"
						size="sm"
						onclick={fetchLatest}
						disabled={fetching}
						class="gap-1.5"
					>
						<DownloadIcon class="size-3.5 {fetching ? 'animate-pulse' : ''}" />
						{fetching ? 'Fetching…' : `Fetch latest from ${provider?.displayName ?? 'app'}`}
					</Button>
				{/if}
			</div>

			<!-- Cap the editor height and scroll internally — the shadcn Textarea uses
			     field-sizing-content, so a large fetched payload would otherwise grow to fill the
			     screen. min-h keeps a comfortable default; max-h + overflow adds a scrollbar. -->
			<Textarea
				id="test-payload"
				bind:value={jsonText}
				spellcheck={false}
				class="max-h-[45vh] min-h-40 resize-y overflow-auto font-mono text-xs break-all"
			/>
			{#if jsonError}
				<p class="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
					{jsonError}
				</p>
			{/if}

			{#if triggerKind === 'app' && event?.payloadShape}
				<p class="text-xs text-muted-foreground">
					Shape: <code class="rounded bg-muted px-1 py-0.5">{event.payloadShape}</code>
				</p>
			{:else if triggerKind === 'manual' || triggerKind === 'cron'}
				<p class="text-xs text-muted-foreground">
					Manual and scheduled triggers carry no external data — an empty object is fine.
				</p>
			{:else if triggerKind === 'app' && !canFetchLatest}
				<p class="text-xs text-muted-foreground">
					This app can't be sampled (inbound-only). Paste a representative event payload.
				</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => onOpenChange(false)}>Cancel</Button>
			<Button type="button" onclick={confirm} disabled={busy} class="gap-1.5">
				<PlayIcon class="size-4" />
				{busy ? 'Starting…' : confirmLabel}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
