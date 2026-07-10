<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { api } from '$lib/api.client.js';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte.js';
	import type { McpServer, McpTransport, McpAuthType } from '@repo/types';

	interface Props {
		open: boolean;
		/** Called with the newly created server(s) so the parent can prepend them. */
		onCreated: (servers: McpServer[]) => void;
	}

	let { open = $bindable(), onCreated }: Props = $props();

	// ── URL tab state ─────────────────────────────────────────────────────────
	let name = $state('');
	let url = $state('');
	let transport = $state<McpTransport>('http');
	let authType = $state<McpAuthType>('none');
	let headers = $state<{ name: string; value: string }[]>([{ name: '', value: '' }]);
	let submitting = $state(false);

	const transportLabel = $derived(
		transport === 'http' ? 'Streamable HTTP' : transport === 'sse' ? 'SSE (legacy)' : 'stdio'
	);
	const authLabel = $derived(
		authType === 'none' ? 'None' : authType === 'header' ? 'Header / token' : 'OAuth'
	);

	function addHeaderRow() {
		headers = [...headers, { name: '', value: '' }];
	}
	function removeHeaderRow(i: number) {
		headers = headers.filter((_, idx) => idx !== i);
		if (headers.length === 0) headers = [{ name: '', value: '' }];
	}

	function resetUrlForm() {
		name = '';
		url = '';
		transport = 'http';
		authType = 'none';
		headers = [{ name: '', value: '' }];
	}

	async function submitUrl() {
		if (!name.trim() || !url.trim()) {
			setAlert({ type: 'warning', title: 'Missing fields', message: 'Name and URL are required.', duration: 4000, show: true });
			return;
		}
		submitting = true;
		try {
			const headerMap: Record<string, string> = {};
			if (authType === 'header') {
				for (const h of headers) if (h.name.trim()) headerMap[h.name.trim()] = h.value;
			}
			const res = await api('/mcp-servers', {
				method: 'POST',
				body: JSON.stringify({
					name: name.trim(),
					transport,
					url: url.trim(),
					authType,
					data: authType === 'header' ? { headers: headerMap } : {}
				})
			});
			const body = await res.json();
			if (!res.ok || !body.success) {
				setAlert({ type: 'error', title: 'Failed to add server', message: body.error ?? 'Please try again.', duration: 5000, show: true });
				return;
			}
			onCreated([body.data as McpServer]);
			setAlert({ type: 'success', title: 'MCP server added', message: `"${name.trim()}" was added. Test it to discover its tools.`, duration: 5000, show: true });
			resetUrlForm();
			open = false;
		} catch {
			setAlert({ type: 'error', title: 'Failed to add server', message: 'Could not reach the server.', duration: 5000, show: true });
		} finally {
			submitting = false;
		}
	}

	// ── Import tab state ──────────────────────────────────────────────────────
	let importJson = $state('');

	async function submitImport() {
		if (!importJson.trim()) return;
		submitting = true;
		try {
			const res = await api('/mcp-servers/import', {
				method: 'POST',
				body: JSON.stringify({ json: importJson })
			});
			const body = await res.json();
			if (!res.ok || !body.success) {
				setAlert({ type: 'error', title: 'Import failed', message: body.error ?? 'Invalid config.', duration: 5000, show: true });
				return;
			}
			const created = (body.data.created ?? []) as McpServer[];
			onCreated(created);
			setAlert({ type: 'success', title: 'Servers imported', message: `Imported ${created.length} server${created.length === 1 ? '' : 's'}. Test each to discover its tools.`, duration: 5000, show: true });
			importJson = '';
			open = false;
		} catch {
			setAlert({ type: 'error', title: 'Import failed', message: 'Could not reach the server.', duration: 5000, show: true });
		} finally {
			submitting = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Add MCP server</Dialog.Title>
			<Dialog.Description>
				Connect a Model Context Protocol server by URL, or paste a standard
				<code class="rounded bg-muted px-1 py-0.5 text-xs">mcpServers</code> config.
			</Dialog.Description>
		</Dialog.Header>

		<Tabs.Root value="url">
			<Tabs.List class="grid w-full grid-cols-2">
				<Tabs.Trigger value="url">By URL</Tabs.Trigger>
				<Tabs.Trigger value="import">Paste JSON</Tabs.Trigger>
			</Tabs.List>

			<!-- ── URL ────────────────────────────────────────────────────────── -->
			<Tabs.Content value="url" class="space-y-4 pt-2">
				<div class="space-y-1.5">
					<Label for="mcp-name">Name</Label>
					<Input id="mcp-name" bind:value={name} placeholder="e.g. Notion" />
				</div>
				<div class="space-y-1.5">
					<Label for="mcp-url">Server URL</Label>
					<Input id="mcp-url" bind:value={url} placeholder="https://mcp.example.com/mcp" />
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div class="space-y-1.5">
						<Label>Transport</Label>
						<Select.Root type="single" bind:value={transport}>
							<Select.Trigger>{transportLabel}</Select.Trigger>
							<Select.Content>
								<Select.Item value="http">Streamable HTTP</Select.Item>
								<Select.Item value="sse">SSE (legacy)</Select.Item>
							</Select.Content>
						</Select.Root>
					</div>
					<div class="space-y-1.5">
						<Label>Authentication</Label>
						<Select.Root type="single" bind:value={authType}>
							<Select.Trigger>{authLabel}</Select.Trigger>
							<Select.Content>
								<Select.Item value="none">None</Select.Item>
								<Select.Item value="header">Header / token</Select.Item>
							</Select.Content>
						</Select.Root>
					</div>
				</div>

				{#if authType === 'header'}
					<div class="space-y-2">
						<Label>Auth headers</Label>
						{#each headers as header, i (i)}
							<div class="flex items-center gap-2">
								<Input placeholder="Header name (e.g. Authorization)" bind:value={header.name} />
								<Input placeholder="Value (e.g. Bearer …)" bind:value={header.value} />
								<Button
									type="button"
									variant="ghost"
									size="sm"
									class="shrink-0 text-muted-foreground"
									onclick={() => removeHeaderRow(i)}
								>
									<XIcon class="size-3.5" />
								</Button>
							</div>
						{/each}
						<Button type="button" variant="outline" size="sm" class="gap-1.5" onclick={addHeaderRow}>
							<PlusIcon class="size-3.5" />
							Add header
						</Button>
						<p class="text-xs text-muted-foreground">
							Header values are encrypted and never sent to the agent sandbox.
						</p>
					</div>
				{/if}

				<Dialog.Footer>
					<Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
					<Button type="button" disabled={submitting} onclick={submitUrl}>
						{submitting ? 'Adding…' : 'Add server'}
					</Button>
				</Dialog.Footer>
			</Tabs.Content>

			<!-- ── Import JSON ────────────────────────────────────────────────── -->
			<Tabs.Content value="import" class="space-y-4 pt-2">
				<div class="space-y-1.5">
					<Label for="mcp-json">Config JSON</Label>
					<Textarea
						id="mcp-json"
						bind:value={importJson}
						rows={10}
						class="font-mono text-xs"
						placeholder={'{\n  "mcpServers": {\n    "example": { "url": "https://mcp.example.com/mcp" }\n  }\n}'}
					/>
					<p class="text-xs text-muted-foreground">
						Paste an <code class="rounded bg-muted px-1 py-0.5">mcpServers</code> (or VS Code
						<code class="rounded bg-muted px-1 py-0.5">servers</code>) object from any marketplace.
						Remote (URL) servers connect immediately; local (command) servers are stored.
					</p>
				</div>
				<Dialog.Footer>
					<Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
					<Button type="button" disabled={submitting} onclick={submitImport}>
						{submitting ? 'Importing…' : 'Import'}
					</Button>
				</Dialog.Footer>
			</Tabs.Content>
		</Tabs.Root>
	</Dialog.Content>
</Dialog.Root>
