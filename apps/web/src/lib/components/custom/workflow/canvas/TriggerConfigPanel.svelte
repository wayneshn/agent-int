<script lang="ts">
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import CronSchedulePicker from '../CronSchedulePicker.svelte';
	import AppTriggerPicker from '../AppTriggerPicker.svelte';
	import type {
		AgentTriggerKind,
		CredentialMetadata,
		AppTriggerProviderInfo,
		AppTriggerRegistrationStatus
	} from '@repo/types';
	import PlayIcon from '@lucide/svelte/icons/play';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import WebhookIcon from '@lucide/svelte/icons/webhook';
	import BlocksIcon from '@lucide/svelte/icons/blocks';
	import CopyIcon from '@lucide/svelte/icons/copy';

	/** Trigger configuration form, shown in the node-config Sheet when the trigger
	 *  node is selected. The trigger is a separate entity from the graph — this binds
	 *  the page-level trigger state that gets serialized into the save payload. */
	interface Props {
		triggerKind: AgentTriggerKind;
		cronSchedule: string;
		cronTimezone: string;
		webhookRequireSignature: boolean;
		appProvider: string;
		appEvent: string;
		appCredentialId: string;
		appParams: Record<string, unknown>;
		appPollIntervalSec: number | undefined;
		providers: AppTriggerProviderInfo[];
		/** Credentials this agent can use — the app-trigger picker filters these by provider type. */
		credentials: CredentialMetadata[];
		webhookSecret: string | null;
		webhookUrl: string | null;
		triggerId: string | null;
		appRegistration?: AppTriggerRegistrationStatus;
	}

	let {
		triggerKind = $bindable(),
		cronSchedule = $bindable(),
		cronTimezone = $bindable(),
		webhookRequireSignature = $bindable(),
		appProvider = $bindable(),
		appEvent = $bindable(),
		appCredentialId = $bindable(),
		appParams = $bindable(),
		appPollIntervalSec = $bindable(),
		providers,
		credentials,
		webhookSecret,
		webhookUrl,
		triggerId,
		appRegistration
	}: Props = $props();

	let copiedSecret = $state(false);
	let copiedUrl = $state(false);

	function copyToClipboard(text: string, field: 'secret' | 'url') {
		navigator.clipboard.writeText(text).then(() => {
			if (field === 'secret') {
				copiedSecret = true;
				setTimeout(() => (copiedSecret = false), 2000);
			} else {
				copiedUrl = true;
				setTimeout(() => (copiedUrl = false), 2000);
			}
		});
	}
</script>

<div class="space-y-4">
	<!-- Kind selector -->
	<div class="space-y-1.5">
		<Label for="trigger-kind">Trigger type</Label>
		<Select.Root
			type="single"
			value={triggerKind}
			onValueChange={(v) => {
				if (v === 'manual' || v === 'cron' || v === 'webhook' || v === 'app') triggerKind = v;
			}}
		>
			<Select.Trigger id="trigger-kind" class="w-full">
				{#if triggerKind === 'manual'}
					<span class="flex items-center gap-2"><PlayIcon class="size-4" /> Manual</span>
				{:else if triggerKind === 'cron'}
					<span class="flex items-center gap-2"><ClockIcon class="size-4" /> Scheduled (Cron)</span>
				{:else if triggerKind === 'app'}
					<span class="flex items-center gap-2"><BlocksIcon class="size-4" /> App event</span>
				{:else}
					<span class="flex items-center gap-2"><WebhookIcon class="size-4" /> Webhook</span>
				{/if}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="manual">
					<span class="flex items-center gap-2"><PlayIcon class="size-4" /> Manual</span>
				</Select.Item>
				<Select.Item value="cron">
					<span class="flex items-center gap-2"><ClockIcon class="size-4" /> Scheduled (Cron)</span>
				</Select.Item>
				<Select.Item value="webhook">
					<span class="flex items-center gap-2"><WebhookIcon class="size-4" /> Webhook</span>
				</Select.Item>
				<Select.Item value="app">
					<span class="flex items-center gap-2"><BlocksIcon class="size-4" /> App event</span>
				</Select.Item>
			</Select.Content>
		</Select.Root>
	</div>

	{#if triggerKind === 'cron'}
		<div class="space-y-4 rounded-lg border border-border p-4">
			<CronSchedulePicker bind:value={cronSchedule} />
			<div class="space-y-1.5">
				<Label for="cron-schedule">
					Expression
					<a
						href="https://crontab.guru/"
						target="_blank"
						rel="noopener noreferrer"
						class="ml-1 text-xs font-normal text-muted-foreground underline-offset-2 hover:underline"
					>
						reference ↗
					</a>
				</Label>
				<Input
					id="cron-schedule"
					type="text"
					bind:value={cronSchedule}
					placeholder="0 9 * * 1-5"
					class="font-mono text-sm"
				/>
			</div>
			<div class="space-y-1.5">
				<Label for="cron-timezone">
					Timezone
					<span class="ml-1 font-normal text-muted-foreground">(optional)</span>
				</Label>
				<Input
					id="cron-timezone"
					type="text"
					bind:value={cronTimezone}
					placeholder="UTC"
					class="font-mono text-sm"
				/>
				<p class="text-xs text-muted-foreground">
					IANA timezone name, e.g.
					<code class="rounded bg-muted px-1 py-0.5">America/New_York</code>
				</p>
			</div>
		</div>
	{:else if triggerKind === 'webhook'}
		<div class="space-y-3 rounded-lg border border-border p-4">
			<p class="text-xs text-muted-foreground">
				A webhook endpoint and HMAC secret are generated automatically when the workflow is created.
				Use the secret to sign requests with the
				<code class="rounded bg-muted px-1 py-0.5">X-Hub-Signature-256</code> header.
			</p>

			<div class="flex items-center justify-between gap-4">
				<div class="space-y-0.5">
					<Label for="webhook-require-signature" class="text-xs">
						Require signed requests (HMAC-SHA256)
					</Label>
					<p class="text-xs text-muted-foreground">
						Reject requests without a valid
						<code class="rounded bg-muted px-1 py-0.5">X-Hub-Signature-256</code> signature.
					</p>
				</div>
				<Switch
					id="webhook-require-signature"
					checked={webhookRequireSignature}
					onCheckedChange={(checked: boolean) => (webhookRequireSignature = checked)}
					aria-label="Require signed webhook requests"
				/>
			</div>
			{#if !webhookRequireSignature}
				<p class="text-xs text-amber-600 dark:text-amber-400">
					Signature verification is off — anyone who knows the webhook URL can trigger this
					workflow.
				</p>
			{/if}

			{#if webhookSecret && webhookUrl}
				<div class="space-y-2">
					<div class="space-y-1.5">
						<Label class="text-xs">Webhook URL</Label>
						<div class="flex items-center gap-2">
							<Input type="text" value={webhookUrl} readonly class="font-mono text-xs" />
							<Button
								type="button"
								variant="outline"
								size="sm"
								onclick={() => copyToClipboard(webhookUrl!, 'url')}
								class="shrink-0"
							>
								<CopyIcon class="size-4" />
								<span class="sr-only">{copiedUrl ? 'Copied!' : 'Copy URL'}</span>
							</Button>
						</div>
					</div>
					{#if webhookRequireSignature}
						<div class="space-y-1.5">
							<Label class="text-xs">HMAC Secret</Label>
							<div class="flex items-center gap-2">
								<Input type="text" value={webhookSecret} readonly class="font-mono text-xs" />
								<Button
									type="button"
									variant="outline"
									size="sm"
									onclick={() => copyToClipboard(webhookSecret!, 'secret')}
									class="shrink-0"
								>
									<CopyIcon class="size-4" />
									<span class="sr-only">{copiedSecret ? 'Copied!' : 'Copy secret'}</span>
								</Button>
							</div>
							<p class="text-xs text-muted-foreground">
								{copiedSecret
									? '✓ Copied to clipboard'
									: 'Keep this secret safe — it verifies incoming requests.'}
							</p>
						</div>
					{/if}
				</div>
			{:else}
				<p class="text-xs text-amber-600 dark:text-amber-400">
					Save the workflow to generate a webhook URL and secret.
				</p>
			{/if}
		</div>
	{:else if triggerKind === 'app'}
		<AppTriggerPicker
			{providers}
			{credentials}
			bind:provider={appProvider}
			bind:event={appEvent}
			bind:credentialId={appCredentialId}
			bind:params={appParams}
			bind:pollIntervalSec={appPollIntervalSec}
			deliveryUrl={webhookUrl}
			{triggerId}
			registration={appRegistration}
		/>
	{:else}
		<div class="rounded-lg border border-border p-4">
			<p class="text-xs text-muted-foreground">
				Manual triggers are fired on demand from the Workflows list page or via the
				<code class="rounded bg-muted px-1 py-0.5">trigger_workflow</code> agent tool.
			</p>
		</div>
	{/if}
</div>
