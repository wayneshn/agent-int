<script lang="ts">
	import PageHeader from '$lib/components/page-header.svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import McpServerDialog from '$lib/components/custom/mcp/mcp-server-dialog.svelte';
	import McpToolsDialog from '$lib/components/custom/mcp/mcp-tools-dialog.svelte';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import SettingsIcon from '@lucide/svelte/icons/settings-2';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { api } from '$lib/api.client.js';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte.js';
	import type { McpServer } from '@repo/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let servers = $state<McpServer[]>(data.servers);
	$effect(() => {
		servers = data.servers;
	});

	// ── Add dialog ────────────────────────────────────────────────────────────
	let addDialogOpen = $state(false);
	function handleCreated(created: McpServer[]) {
		servers = [...created, ...servers];
	}

	// ── Edit dialog ───────────────────────────────────────────────────────────
	let editDialogOpen = $state(false);
	let editServer = $state<McpServer | null>(null);
	function openEdit(server: McpServer) {
		editServer = server;
		editDialogOpen = true;
	}
	function handleEdited(updated: McpServer) {
		servers = servers.map((s) => (s.id === updated.id ? updated : s));
		if (activeServer?.id === updated.id) activeServer = updated;
	}

	// ── Tools dialog ──────────────────────────────────────────────────────────
	let toolsDialogOpen = $state(false);
	let activeServer = $state<McpServer | null>(null);
	function openTools(server: McpServer) {
		activeServer = server;
		toolsDialogOpen = true;
	}
	function handleUpdated(updated: McpServer) {
		servers = servers.map((s) => (s.id === updated.id ? updated : s));
		if (activeServer?.id === updated.id) activeServer = updated;
	}

	// ── Delete dialog ─────────────────────────────────────────────────────────
	let serverToDelete = $state<McpServer | null>(null);
	let deleteDialogOpen = $state(false);
	let deleting = $state(false);

	function openDeleteDialog(server: McpServer) {
		serverToDelete = server;
		deleteDialogOpen = true;
	}

	async function confirmDelete() {
		if (!serverToDelete) return;
		deleting = true;
		try {
			const res = await api(`/mcp-servers/${serverToDelete.id}`, { method: 'DELETE' });
			const body = await res.json();
			if (!res.ok || !body.success) {
				setAlert({ type: 'error', title: 'Failed to delete', message: body.error ?? 'Please try again.', duration: 5000, show: true });
				return;
			}
			setAlert({ type: 'success', title: 'MCP server removed', message: `"${serverToDelete.name}" was removed.`, duration: 4000, show: true });
			servers = servers.filter((s) => s.id !== serverToDelete!.id);
			deleteDialogOpen = false;
			serverToDelete = null;
		} catch {
			setAlert({ type: 'error', title: 'Failed to delete', message: 'Could not reach the server.', duration: 5000, show: true });
		} finally {
			deleting = false;
		}
	}

	function statusVariant(status: McpServer['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (status === 'connected') return 'default';
		if (status === 'error') return 'destructive';
		if (status === 'needs_auth') return 'outline';
		return 'secondary';
	}
</script>

<svelte:head>
	<title>MCP Servers — Valmis Dashboard</title>
	<meta
		name="description"
		content="Connect Model Context Protocol servers to give your agents new tools."
	/>
</svelte:head>

<div class="flex flex-col gap-6 p-6">
	<PageHeader
		title="MCP Servers"
		description="Connect Model Context Protocol servers to give your agents new tools. Assign servers to an agent from its edit page."
	>
		{#snippet actions()}
			<Button class="gap-1.5" onclick={() => (addDialogOpen = true)}>
				<PlusIcon class="size-4" />
				Add server
			</Button>
		{/snippet}
	</PageHeader>

	{#if servers.length === 0}
		<Card.Root>
			<Card.Content>
				<div class="flex flex-col items-center gap-2 py-8">
					<PlugIcon class="size-6 text-muted-foreground" />
					<p class="text-sm text-muted-foreground">No MCP servers yet.</p>
					<p class="max-w-md text-center text-xs text-muted-foreground">
						Add a server by URL or paste an <code class="rounded bg-muted px-1 py-0.5">mcpServers</code>
						config from any marketplace. Once connected, choose which tools to expose and assign the
						server to your agents.
					</p>
				</div>
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Content>
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Name</Table.Head>
							<Table.Head>Transport</Table.Head>
							<Table.Head>Auth</Table.Head>
							<Table.Head>Status</Table.Head>
							<Table.Head class="text-right">Tools</Table.Head>
							<Table.Head class="w-24"></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each servers as server (server.id)}
							{@const enabled = (server.tools ?? []).filter((t) => t.enabled).length}
							<Table.Row>
								<Table.Cell class="max-w-64">
									<div class="flex items-center gap-2">
										<PlugIcon class="size-4 shrink-0 text-muted-foreground" />
										<span class="truncate text-sm font-medium" title={server.name}>{server.name}</span>
									</div>
									{#if server.url}
										<p class="mt-0.5 max-w-56 truncate text-xs text-muted-foreground" title={server.url}>
											{server.url}
										</p>
									{/if}
								</Table.Cell>
								<Table.Cell>
									<Badge variant="outline" class="text-xs uppercase">{server.transport}</Badge>
								</Table.Cell>
								<Table.Cell>
									<Badge variant="outline" class="text-xs capitalize">{server.authType}</Badge>
								</Table.Cell>
								<Table.Cell>
									<Badge variant={statusVariant(server.status)} class="text-xs capitalize">
										{server.status.replace('_', ' ')}
									</Badge>
								</Table.Cell>
								<Table.Cell class="text-right text-sm text-muted-foreground">
									{enabled}/{(server.tools ?? []).length}
								</Table.Cell>
								<Table.Cell>
									<div class="flex items-center justify-end gap-1">
										<Button
											variant="ghost"
											size="sm"
											class="text-muted-foreground"
											title="Edit server"
											onclick={() => openEdit(server)}
										>
											<PencilIcon class="size-3.5" />
										</Button>
										<Button
											variant="ghost"
											size="sm"
											class="text-muted-foreground"
											title="Manage tools"
											onclick={() => openTools(server)}
										>
											<SettingsIcon class="size-3.5" />
										</Button>
										<Button
											variant="ghost"
											size="sm"
											class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
											title="Remove server"
											onclick={() => openDeleteDialog(server)}
										>
											<Trash2Icon class="size-3.5" />
										</Button>
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>
	{/if}
</div>

<McpServerDialog bind:open={addDialogOpen} onCreated={handleCreated} />
<McpServerDialog bind:open={editDialogOpen} server={editServer} onUpdated={handleEdited} />
<McpToolsDialog bind:open={toolsDialogOpen} server={activeServer} onUpdated={handleUpdated} />

<!-- ── Delete confirmation ────────────────────────────────────────────────── -->
<Dialog.Root bind:open={deleteDialogOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Remove MCP server</Dialog.Title>
			<Dialog.Description>
				This removes "{serverToDelete?.name}" and unassigns it from every agent using it. This
				cannot be undone.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (deleteDialogOpen = false)}>Cancel</Button>
			<Button type="button" variant="destructive" disabled={deleting} onclick={confirmDelete}>
				{deleting ? 'Removing…' : 'Remove'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
