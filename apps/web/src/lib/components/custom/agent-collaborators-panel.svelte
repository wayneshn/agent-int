<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import AgentAvatar from '$lib/components/custom/chat/AgentAvatar.svelte';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { fade } from 'svelte/transition';

	/** Minimal agent shape needed to pick collaborators */
	interface CollaboratorOption {
		id: string;
		name: string;
		description?: string;
		avatarUrl?: string;
	}

	interface Props {
		/** Bindable Set — parent serialises this into hidden `collaboratorIds` inputs */
		selectedCollaboratorIds: Set<string>;
		/** All of the owner's agents (candidates). The current agent is excluded via currentAgentId. */
		agents: CollaboratorOption[];
		/** The agent being edited — excluded from the candidate list (an agent can't message itself) */
		currentAgentId?: string | null;
	}

	let { selectedCollaboratorIds = $bindable(), agents, currentAgentId = null }: Props = $props();

	// Candidate agents = everyone except the agent being edited.
	const candidates = $derived<CollaboratorOption[]>(
		agents.filter((a) => a.id !== currentAgentId)
	);

	// ── Add-collaborators dialog state ────────────────────────────────────────
	let addDialogOpen = $state(false);
	/** Draft copy of selection — only committed on "Done" */
	let draftIds = $state<Set<string>>(new Set());

	function openAddDialog() {
		draftIds = new Set(selectedCollaboratorIds);
		addDialogOpen = true;
	}

	function toggleDraft(id: string) {
		const next = new Set(draftIds);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		draftIds = next;
	}

	function confirmSelection() {
		selectedCollaboratorIds = new Set(draftIds);
		addDialogOpen = false;
	}

	function removeCollaborator(id: string) {
		const next = new Set(selectedCollaboratorIds);
		next.delete(id);
		selectedCollaboratorIds = next;
	}

	/** Derive the selected agent objects for display on the card */
	const selectedAgents = $derived<CollaboratorOption[]>(
		[...selectedCollaboratorIds]
			.map((id) => candidates.find((a) => a.id === id))
			.filter((a): a is CollaboratorOption => a !== undefined)
	);
</script>

<!-- ── Collaborators Card ─────────────────────────────────────────────────── -->
<Card.Root>
	<Card.Header class="flex flex-row items-start justify-between gap-4">
		<div>
			<Card.Title class="text-sm font-medium">Agent collaborators</Card.Title>
			<Card.Description class="text-xs">
				Choose which of your other agents this agent may message and delegate work to
				(via the ask_agent / send_to_agent tools). Access is one-directional.
			</Card.Description>
		</div>
		<Button
			type="button"
			variant="outline"
			size="sm"
			class="shrink-0 gap-1.5"
			onclick={openAddDialog}
			disabled={candidates.length === 0}
		>
			<PlusIcon class="size-3.5" />
			Add agent
		</Button>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if candidates.length === 0}
			<p class="text-sm text-muted-foreground">
				You have no other agents yet. Create another agent to enable agent-to-agent messaging.
			</p>
		{:else if selectedAgents.length === 0}
			<div class="flex flex-col items-center gap-2 py-6">
				<p class="text-sm text-muted-foreground">No collaborators selected.</p>
			</div>
		{:else}
			<div class="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
				{#each selectedAgents as a (a.id)}
					<div
						class="flex h-11 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 transition-colors hover:bg-muted/60"
						transition:fade
					>
						<AgentAvatar avatarUrl={a.avatarUrl} name={a.name} size="sm" />
						<span class="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
							{a.name}
						</span>
						<button
							type="button"
							onclick={() => removeCollaborator(a.id)}
							class="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
							title="Remove {a.name}"
						>
							<XIcon class="size-3" />
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</Card.Content>
</Card.Root>

<!-- ── Add Collaborators Dialog ───────────────────────────────────────────── -->
<Dialog.Root bind:open={addDialogOpen}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Select agents to message</Dialog.Title>
			<Dialog.Description>
				This agent will be able to hand tasks to the agents you select. Changes apply when you save.
			</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-32">
			{#if candidates.length === 0}
				<p class="py-8 text-center text-sm text-muted-foreground">
					You have no other agents to message.
				</p>
			{:else}
				<div class="max-h-96 space-y-2 overflow-y-auto pr-1">
					{#each candidates as a (a.id)}
						{@const isDraft = draftIds.has(a.id)}
						<label
							class="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2.5 transition-colors hover:bg-muted/50 {isDraft
								? 'border-primary bg-primary/5'
								: ''}"
						>
							<input
								type="checkbox"
								checked={isDraft}
								onchange={() => toggleDraft(a.id)}
								class="size-4 rounded border-border accent-primary"
							/>
							<AgentAvatar avatarUrl={a.avatarUrl} name={a.name} size="sm" />
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium text-foreground">{a.name}</p>
								{#if a.description}
									<p class="truncate text-xs text-muted-foreground">{a.description}</p>
								{/if}
							</div>
						</label>
					{/each}
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (addDialogOpen = false)}>
				Cancel
			</Button>
			<Button type="button" onclick={confirmSelection}>Done</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
