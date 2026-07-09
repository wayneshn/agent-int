<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import type { McpServer } from '@repo/types';
	import { fade } from 'svelte/transition';

	interface Props {
		/** Bindable Set — parent serialises this into hidden form inputs */
		selectedMcpServerIds: Set<string>;
		/** All MCP servers owned by the user, loaded by the parent page */
		servers: McpServer[];
	}

	let { selectedMcpServerIds = $bindable(), servers }: Props = $props();

	let addDialogOpen = $state(false);
	let draftIds = $state<Set<string>>(new Set());

	function openAddDialog() {
		draftIds = new Set(selectedMcpServerIds);
		addDialogOpen = true;
	}
	function toggleDraft(id: string) {
		const next = new Set(draftIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		draftIds = next;
	}
	function confirmSelection() {
		selectedMcpServerIds = new Set(draftIds);
		addDialogOpen = false;
	}
	function removeServer(id: string) {
		const next = new Set(selectedMcpServerIds);
		next.delete(id);
		selectedMcpServerIds = next;
	}

	const selectedServers = $derived<McpServer[]>(
		[...selectedMcpServerIds]
			.map((id) => servers.find((s) => s.id === id))
			.filter((s): s is McpServer => s !== undefined)
	);

	function enabledToolCount(server: McpServer): number {
		return (server.tools ?? []).filter((t) => t.enabled).length;
	}
</script>

<Card.Root>
	<Card.Header class="flex flex-row items-start justify-between gap-4">
		<div>
			<Card.Title class="text-sm font-medium">MCP servers</Card.Title>
			<Card.Description class="text-xs">
				Give this agent tools from connected Model Context Protocol servers.
			</Card.Description>
		</div>
		<Button type="button" variant="outline" size="sm" class="shrink-0 gap-1.5" onclick={openAddDialog}>
			<PlusIcon class="size-3.5" />
			Add server
		</Button>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if selectedServers.length === 0}
			<div class="flex flex-col items-center gap-2 py-6">
				<p class="text-sm text-muted-foreground">No MCP servers assigned.</p>
			</div>
		{:else}
			<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
				{#each selectedServers as server (server.id)}
					<div
						class="flex h-9 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 transition-colors hover:bg-muted/60"
						transition:fade
					>
						<PlugIcon class="size-3.5 shrink-0 text-muted-foreground" />
						<span class="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{server.name}</span>
						<Badge variant="outline" class="shrink-0 text-[10px]">{enabledToolCount(server)} tools</Badge>
						<button
							type="button"
							onclick={() => removeServer(server.id)}
							class="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
							title="Remove {server.name}"
						>
							<XIcon class="size-3" />
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</Card.Content>
</Card.Root>

<Dialog.Root bind:open={addDialogOpen}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Select MCP servers</Dialog.Title>
			<Dialog.Description>
				Choose which servers this agent can use. Their enabled tools are added to the agent.
			</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-32">
			{#if servers.length === 0}
				<p class="py-8 text-center text-sm text-muted-foreground">
					No MCP servers configured.
					<a href="/app/mcp-servers" class="underline underline-offset-2 hover:text-foreground">
						Add a server
					</a>
					first.
				</p>
			{:else}
				<div class="max-h-96 space-y-2 overflow-y-auto pr-1">
					{#each servers as server (server.id)}
						{@const isDraft = draftIds.has(server.id)}
						<label
							class="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2.5 transition-colors hover:bg-muted/50 {isDraft
								? 'border-primary bg-primary/5'
								: ''}"
						>
							<input
								type="checkbox"
								checked={isDraft}
								onchange={() => toggleDraft(server.id)}
								class="size-4 rounded border-border accent-primary"
							/>
							<PlugIcon class="size-4 shrink-0 text-muted-foreground" />
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium text-foreground">{server.name}</p>
								<p class="text-xs text-muted-foreground">
									{enabledToolCount(server)} tools · {server.status.replace('_', ' ')}
								</p>
							</div>
						</label>
					{/each}
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (addDialogOpen = false)}>Cancel</Button>
			<Button type="button" onclick={confirmSelection}>Done</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
