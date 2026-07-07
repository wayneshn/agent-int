<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import AgentAvatar from './AgentAvatar.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { api } from '$lib/api.client.js';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import MoreHorizontalIcon from '@lucide/svelte/icons/ellipsis';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import type { Agent, AgentThread } from '@repo/types';

	/**
	 * Left-panel sidebar for the chat view.
	 *
	 * Desktop (md+): always visible as a 260px panel in the normal flex row.
	 * Mobile: hidden. A floating toggle button (top-left, below the global header)
	 * opens it as a full-height overlay that slides in from the left.
	 * The toggle is self-contained inside this component — no top bar needed in pages.
	 */
	let {
		agent,
		threads = $bindable(),
		activeThreadId,
		isCreatingThread = false,
		open = $bindable(false),
		browserAvailable = false,
		onNewChat,
		onRenameThread,
		onDeleteThread,
		onBrowserSession
	}: {
		agent: Agent;
		threads: AgentThread[];
		activeThreadId?: string;
		isCreatingThread?: boolean;
		open: boolean;
		/** When true, show the per-thread "Browser" menu item (agent has browser access). */
		browserAvailable?: boolean;
		onNewChat: () => void;
		onRenameThread: (thread: AgentThread) => void;
		onDeleteThread: (thread: AgentThread) => void;
		/** Open the browser-session management modal for the given thread. */
		onBrowserSession?: (thread: AgentThread) => void;
	} = $props();

	function formatThreadDate(date: Date | string): string {
		const d = new Date(date);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const diffDays = Math.floor(diffMs / 86_400_000);
		if (diffDays === 0) return 'Today';
		if (diffDays === 1) return 'Yesterday';
		if (diffDays < 7) return `${diffDays} days ago`;
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function threadTitle(thread: AgentThread): string {
		return thread.title ?? 'New conversation';
	}

	/** Controls whether workflow-created threads are shown in the list. Default: hidden. */
	let showWorkflowThreads = $state(false);

	/**
	 * When the toggle is switched on, invalidate the current page's load function
	 * so SvelteKit re-fetches the full thread list (which includes workflow threads
	 * created in the background since the page was first loaded).
	 */
	$effect(() => {
		if (showWorkflowThreads) {
			void invalidateAll();
		}
	});

	/**
	 * Sort threads so that pinned ones always come first.
	 * Within each group (pinned / unpinned) threads are ordered by updatedAt DESC.
	 * Workflow-thread filter is applied before the sort.
	 */
	/**
	 * Background threads are those not started by the user directly in chat — workflow
	 * runs and agent-to-agent messages. Both are hidden behind the same toggle.
	 */
	const isBackgroundThread = (t: (typeof threads)[number]) =>
		t.isWorkflowThread || t.triggerType === 'agent';

	let filteredThreads = $derived(() => {
		const base = showWorkflowThreads ? [...threads] : threads.filter((t) => !isBackgroundThread(t));

		const pinned = base
			.filter((t) => t.isPinned)
			.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

		const unpinned = base
			.filter((t) => !t.isPinned)
			.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

		return [...pinned, ...unpinned];
	});

	/** Whether there are any background (workflow / agent-to-agent) threads (shows the toggle) */
	let hasWorkflowThreads = $derived(threads.some((t) => isBackgroundThread(t)));

	/** Desktop sidebar open state */
	let desktopOpen = $state(true);

	/**
	 * Pin or unpin a thread.
	 * Performs an optimistic local update then confirms via the API.
	 * Reverts and shows an error toast on failure.
	 */
	async function handlePinThread(thread: AgentThread, isPinned: boolean) {
		// Optimistic update — mutate the bindable threads array
		threads = threads.map((t) => (t.id === thread.id ? { ...t, isPinned } : t));

		try {
			const res = await api(`/runtime/${agent.id}/threads/${thread.id}/pin`, {
				method: 'PATCH',
				body: JSON.stringify({ isPinned })
			});
			if (!res.ok) {
				// Revert
				threads = threads.map((t) => (t.id === thread.id ? { ...t, isPinned: !isPinned } : t));
				const body = await res.json();
				setAlert({
					type: 'error',
					title: isPinned ? 'Failed to pin' : 'Failed to unpin',
					message: body.error ?? 'Could not update pin status.',
					duration: 5000,
					show: true
				});
			}
		} catch {
			threads = threads.map((t) => (t.id === thread.id ? { ...t, isPinned: !isPinned } : t));
			setAlert({
				type: 'error',
				title: isPinned ? 'Failed to pin' : 'Failed to unpin',
				message: 'An unexpected error occurred.',
				duration: 5000,
				show: true
			});
		}
	}
</script>

<!--
  Mobile backdrop — closes sidebar when tapping outside.
  z-30 sits above page content but below the sidebar (z-40).
-->
{#if open}
	<div
		class="fixed inset-0 z-30 bg-black/30 md:hidden"
		onclick={() => (open = false)}
		aria-hidden="true"
	></div>
{/if}

<!--
  Mobile-only toggle button — floats at the top-left of the chat area.
  Visible only when sidebar is closed and on small screens.
  Positioned below the 72px global app header using top-[72px].
-->
<button
	type="button"
	onclick={() => (open = true)}
	class="fixed top-19 left-3 z-20 flex size-8 items-center justify-center rounded-md
		border border-border/60 bg-background text-muted-foreground shadow-sm
		transition-opacity hover:text-foreground
		md:hidden
		{open ? 'pointer-events-none opacity-0' : 'opacity-100'}"
	title="Open conversations"
	aria-label="Open conversations"
>
	<MessageSquareIcon class="size-4" />
</button>

<!--
  Sidebar panel.
  Desktop: part of the flex row. Width transitions between 260px and 0px.
  Mobile: fixed overlay from top-0 (covers global header), slides in/out.
-->
<aside
	class="
		relative h-full shrink-0 border-r border-border/60
		bg-sidebar transition-all duration-300 ease-in-out
		max-md:fixed max-md:top-0 max-md:bottom-0
		max-md:left-0 max-md:z-40 max-md:w-65 max-md:shadow-xl
		md:relative md:bg-transparent md:shadow-none
		{open ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'}
		{desktopOpen ? 'md:w-65' : 'md:w-0'}
	"
>
	<!-- Inner wrapper prevents content reflow during width transition -->
	<div
		class="flex h-full w-65 flex-col overflow-hidden transition-opacity duration-300 ease-in-out {desktopOpen
			? 'opacity-100'
			: 'opacity-0 max-md:opacity-100'}"
	>
		<!-- Agent identity -->
		<div class="flex items-center gap-3 px-4 py-3">
			<AgentAvatar avatarUrl={agent.avatarUrl} name={agent.name} size="md" />
			<div class="min-w-0 flex-1">
				<h2 class="truncate font-heading text-sm font-semibold text-foreground">{agent.name}</h2>
				{#if agent.description}
					<p class="mt-0.5 truncate text-xs text-muted-foreground">{agent.description}</p>
				{/if}
			</div>
		</div>

		<!-- New chat button -->
		<div class="px-3 pb-3">
			<Button
				variant="outline"
				size="sm"
				class="w-full justify-start gap-2"
				onclick={onNewChat}
				disabled={isCreatingThread}
			>
				<PlusIcon class="size-3.5" />
				{isCreatingThread ? 'Starting…' : 'New chat'}
			</Button>
		</div>

		<!-- Section label + workflow toggle -->
		<div class="flex items-center justify-between px-4 pb-1">
			<p class="text-[10px] font-medium tracking-wider text-muted-foreground/60 uppercase">
				Conversations
			</p>
			{#if hasWorkflowThreads}
				<div
					class="flex items-center gap-1.5"
					title={showWorkflowThreads ? 'Hide workflow threads' : 'Show workflow threads'}
					in:fade={{ duration: 200 }}
				>
					<WorkflowIcon class="size-3 text-muted-foreground/50" />
					<Switch bind:checked={showWorkflowThreads} size="sm" aria-label="Show workflow threads" />
				</div>
			{/if}
		</div>

		<!-- Thread list -->
		<ScrollArea class="flex-1 overflow-hidden">
			{#if filteredThreads().length === 0}
				<div class="flex flex-col items-center gap-2 px-4 py-10 text-center">
					<MessageSquareIcon class="size-7 text-muted-foreground/30" />
					<p class="text-xs text-muted-foreground/70">
						{threads.length === 0 ? 'No conversations yet' : 'No chat conversations'}
					</p>
					{#if threads.length > 0 && !showWorkflowThreads}
						<button
							type="button"
							class="text-xs text-muted-foreground/60 underline underline-offset-2 hover:text-muted-foreground"
							onclick={() => (showWorkflowThreads = true)}
						>
							Show workflow threads
						</button>
					{/if}
				</div>
			{:else}
				<nav class="space-y-0.5 px-2 pb-4">
					{#each filteredThreads() as thread (thread.id)}
						<div
							transition:fly={{ x: -8, duration: 200 }}
							class="group flex items-center rounded-md transition-colors
							{activeThreadId === thread.id
								? 'bg-accent text-accent-foreground'
								: 'text-foreground/70 hover:bg-accent/50 hover:text-foreground'}"
						>
							<a
								href="/app/chat/{agent.id}/{thread.id}"
								onclick={() => (open = false)}
								class="flex min-w-0 flex-1 flex-col px-2.5 py-2"
							>
								<span class="flex items-center gap-1 truncate text-sm leading-snug font-medium">
									{#if thread.isPinned}
										<!-- Small pin indicator shown before the title for pinned threads -->
										<PinIcon class="size-2.5 shrink-0 text-muted-foreground/50" />
									{/if}
									<span class="truncate">{threadTitle(thread)}</span>
								</span>
								<span class="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
									{#if thread.status === 'running'}
										<span class="size-1.5 animate-pulse rounded-full bg-amber-500"></span>
									{:else if thread.status === 'error'}
										<span class="size-1.5 rounded-full bg-destructive"></span>
									{:else}
										<span class="size-1.5 rounded-full bg-muted-foreground/25"></span>
									{/if}
									{formatThreadDate(thread.updatedAt)}
									{#if thread.isWorkflowThread}
										<span
											class="rounded bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground"
										>
											workflow
										</span>
									{:else if thread.triggerType === 'agent'}
										<span
											class="rounded bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground"
										>
											from agent
										</span>
									{/if}
								</span>
							</a>

							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon"
											class="mr-1 size-6 shrink-0 opacity-0 transition-opacity
											group-hover:opacity-100
											{activeThreadId === thread.id ? 'opacity-100' : ''}"
											title="Options"
										>
											<MoreHorizontalIcon class="size-3.5" />
											<span class="sr-only">Thread options</span>
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end" class="w-44">
									<!-- Pin / Unpin -->
									<DropdownMenu.Item
										onSelect={() => handlePinThread(thread, !thread.isPinned)}
										class="gap-2"
									>
										{#if thread.isPinned}
											<PinOffIcon class="size-3.5 text-muted-foreground" />
											Unpin
										{:else}
											<PinIcon class="size-3.5 text-muted-foreground" />
											Pin
										{/if}
									</DropdownMenu.Item>
									<DropdownMenu.Item onSelect={() => onRenameThread(thread)} class="gap-2">
										<PencilIcon class="size-3.5 text-muted-foreground" />
										Rename
									</DropdownMenu.Item>
									{#if browserAvailable}
										<DropdownMenu.Item
											onSelect={() => onBrowserSession?.(thread)}
											class="gap-2"
										>
											<GlobeIcon class="size-3.5 text-muted-foreground" />
											Browser
										</DropdownMenu.Item>
									{/if}
									<DropdownMenu.Separator />
									<DropdownMenu.Item
										onSelect={() => onDeleteThread(thread)}
										class="gap-2 text-destructive focus:text-destructive"
									>
										<Trash2Icon class="size-3.5" />
										Delete
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</div>
					{/each}
				</nav>
			{/if}
		</ScrollArea>
	</div>

	<!-- Clickable right border to toggle desktop sidebar -->
	<button
		type="button"
		class=" absolute top-0 -right-3 bottom-0 z-50 w-3 cursor-ew-resize transition-colors hover:bg-primary/20 max-md:hidden"
		onclick={() => (desktopOpen = !desktopOpen)}
		title={desktopOpen ? 'Collapse sidebar' : 'Expand sidebar'}
		aria-label="Toggle sidebar"
	></button>
</aside>
