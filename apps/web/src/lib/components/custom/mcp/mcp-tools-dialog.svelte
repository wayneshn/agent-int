<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { api } from '$lib/api.client.js';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte.js';
	import type { McpServer, McpToolCacheEntry } from '@repo/types';

	interface Props {
		open: boolean;
		server: McpServer | null;
		/** Called whenever the server's status/tools change so the parent row updates. */
		onUpdated: (server: McpServer) => void;
	}

	let { open = $bindable(), server, onUpdated }: Props = $props();

	let tools = $state<McpToolCacheEntry[]>([]);
	let testing = $state(false);

	// Sync local tool state whenever the dialog opens for a (different) server.
	$effect(() => {
		tools = server?.tools ? [...server.tools] : [];
	});

	const enabledCount = $derived(tools.filter((t) => t.enabled).length);

	async function testConnection() {
		if (!server) return;
		testing = true;
		try {
			const res = await api(`/mcp-servers/${server.id}/test`, { method: 'POST' });
			const body = await res.json();
			if (!res.ok || !body.success) {
				setAlert({ type: 'error', title: 'Connection failed', message: body.error ?? 'Could not connect.', duration: 5000, show: true });
				return;
			}
			const data = body.data as {
				status: McpServer['status'];
				tools: McpToolCacheEntry[];
				error?: string;
			};
			tools = data.tools;
			// Carry the detailed error onto the server so the inline red box updates too.
			onUpdated({ ...server, status: data.status, tools: data.tools, lastError: data.error });
			if (data.status === 'connected') {
				setAlert({ type: 'success', title: 'Connected', message: `Discovered ${data.tools.length} tool${data.tools.length === 1 ? '' : 's'}.`, duration: 4000, show: true });
			} else {
				// Surface the actual error the MCP server returned, not a generic status.
				setAlert({
					type: 'error',
					title: 'Connection failed',
					message: data.error ?? `Server status: ${data.status}.`,
					duration: 10000,
					show: true
				});
			}
		} catch {
			setAlert({ type: 'error', title: 'Connection failed', message: 'Could not reach the server.', duration: 5000, show: true });
		} finally {
			testing = false;
		}
	}

	async function toggleTool(tool: McpToolCacheEntry, enabled: boolean) {
		if (!server) return;
		// Optimistic update.
		tools = tools.map((t) => (t.name === tool.name ? { ...t, enabled } : t));
		try {
			const res = await api(`/mcp-servers/${server.id}/tools`, {
				method: 'PATCH',
				body: JSON.stringify({ toolName: tool.name, enabled })
			});
			const body = await res.json();
			if (!res.ok || !body.success) {
				tools = tools.map((t) => (t.name === tool.name ? { ...t, enabled: !enabled } : t));
				setAlert({ type: 'error', title: 'Update failed', message: body.error ?? 'Please try again.', duration: 4000, show: true });
				return;
			}
			onUpdated({ ...server, tools });
		} catch {
			tools = tools.map((t) => (t.name === tool.name ? { ...t, enabled: !enabled } : t));
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{server?.name} — tools</Dialog.Title>
			<Dialog.Description>
				Choose which tools this server exposes to agents. Every enabled tool is sent to the model
				on each turn, so keep the list focused.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm text-muted-foreground">
				{#if server}
					<Badge variant={server.status === 'connected' ? 'default' : server.status === 'error' ? 'destructive' : 'secondary'} class="capitalize">
						{server.status.replace('_', ' ')}
					</Badge>
				{/if}
				<span>{enabledCount}/{tools.length} enabled</span>
			</div>
			<Button type="button" variant="outline" size="sm" class="gap-1.5" disabled={testing} onclick={testConnection}>
				<RefreshCwIcon class="size-3.5 {testing ? 'animate-spin' : ''}" />
				{testing ? 'Testing…' : 'Test connection'}
			</Button>
		</div>

		{#if server?.lastError}
			<p class="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
				{server.lastError}
			</p>
		{/if}

		<div class="max-h-96 space-y-2 overflow-y-auto pr-1">
			{#if tools.length === 0}
				<p class="py-8 text-center text-sm text-muted-foreground">
					No tools discovered yet. Test the connection to fetch this server's tools.
				</p>
			{:else}
				{#each tools as tool (tool.name)}
					<div class="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5">
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm font-medium text-foreground">{tool.name}</p>
							{#if tool.description}
								<p class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{tool.description}</p>
							{/if}
						</div>
						<Switch checked={tool.enabled} onCheckedChange={(v) => toggleTool(tool, v)} />
					</div>
				{/each}
			{/if}
		</div>

		<Dialog.Footer>
			<Button type="button" onclick={() => (open = false)}>Done</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
