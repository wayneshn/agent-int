<script lang="ts">
	import { page } from '$app/state';
	import { activeBreadcrumbThreadTitle } from '$lib/stores/breadcrumb.store.js';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
	import type { Agent, AgentMission, Workflow } from '@repo/types';

	/**
	 * A breadcrumb item — either a link (with href) or the current page (no href).
	 */
	interface BreadcrumbSegment {
		label: string;
		href?: string;
	}

	/**
	 * Derives breadcrumb segments from the current pathname + search params.
	 * Dynamic names (agent, thread) are pulled from page.data which SvelteKit
	 * populates with the merged load data of all active layouts + the current page.
	 *
	 * Thread title is sourced from `activeBreadcrumbThreadTitle` store first so
	 * optimistic renames (and the initial load) are reflected immediately.
	 */
	let segments = $derived.by((): BreadcrumbSegment[] => {
		const pathname = page.url.pathname;
		const searchParams = page.url.searchParams;

		// Access dynamic entity names from merged page data
		const agent = (page.data as Record<string, unknown>).agent as Agent | null | undefined;
		const workflow = (page.data as Record<string, unknown>).workflow as Workflow | null | undefined;
		const mission = (page.data as Record<string, unknown>).mission as
			| AgentMission
			| null
			| undefined;

		// ── /app ──────────────────────────────────────────────────────────────────
		if (pathname === '/app') {
			return [{ label: 'Home' }];
		}

		// ── /app/chat ─────────────────────────────────────────────────────────────
		if (pathname === '/app/chat') {
			return [{ label: 'Chat' }];
		}

		// ── /app/chat/[agentId] ───────────────────────────────────────────────────
		const chatAgentMatch = pathname.match(/^\/app\/chat\/([^/]+)$/);
		if (chatAgentMatch) {
			const agentName = agent?.name ?? 'Agent';
			return [{ label: 'Chat', href: '/app/chat' }, { label: agentName }];
		}

		// ── /app/chat/[agentId]/[threadId] ────────────────────────────────────────
		const chatThreadMatch = pathname.match(/^\/app\/chat\/([^/]+)\/([^/]+)$/);
		if (chatThreadMatch) {
			const agentId = chatThreadMatch[1];
			const agentName = agent?.name ?? 'Agent';
			// Prefer the live store value; fall back to page.data.thread.title
			const storeTitle = $activeBreadcrumbThreadTitle;
			const pageThread = (page.data as Record<string, unknown>).thread as
				| { title?: string }
				| null
				| undefined;
			const threadTitle = storeTitle ?? pageThread?.title ?? 'Session';
			return [
				{ label: 'Chat', href: '/app/chat' },
				{ label: agentName, href: `/app/chat/${agentId}` },
				{ label: threadTitle }
			];
		}

		// ── /app/agents ───────────────────────────────────────────────────────────
		if (pathname === '/app/agents') {
			return [{ label: 'Agents' }];
		}

		// ── /app/agents/[id]/memory ───────────────────────────────────────────────
		const agentMemoryMatch = pathname.match(/^\/app\/agents\/([^/]+)\/memory$/);
		if (agentMemoryMatch) {
			const agentName = agent?.name ?? 'Agent';
			return [
				{ label: 'Agents', href: '/app/agents' },
				{ label: agentName, href: `/app/agents/new?id=${agentMemoryMatch[1]}&editmode=true` },
				{ label: 'Memory' }
			];
		}

		// ── /app/agents/[id]/runs ────────────────────────────────────────────────
		const agentDetailsMatch = pathname.match(/^\/app\/agents\/([^/]+)\/details$/);
		if (agentDetailsMatch) {
			const agentName = agent?.name ?? 'Agent';
			return [
				{ label: 'Agents', href: '/app/agents' },
				{ label: agentName, href: pathname },
				{ label: 'Details' }
			];
		}

		// ── /app/agents/[id]/workflows/[workflowId]/runs/[runId] ──────────────────
		const workflowRunDetailMatch = pathname.match(
			/^\/app\/agents\/([^/]+)\/workflows\/([^/]+)\/runs\/([^/]+)$/
		);
		if (workflowRunDetailMatch) {
			const agentId = workflowRunDetailMatch[1];
			const workflowId = workflowRunDetailMatch[2];
			const agentName = agent?.name ?? 'Agent';
			const workflowName = workflow?.name ?? 'Workflow';
			return [
				{ label: 'Agents', href: '/app/agents' },
				{ label: agentName, href: `/app/workflows?agentId=${agentId}` },
				{ label: 'Workflows', href: `/app/workflows?agentId=${agentId}` },
				{
					label: workflowName,
					href: `/app/agents/${agentId}/workflows/${workflowId}/runs`
				},
				{ label: 'Runs', href: `/app/agents/${agentId}/workflows/${workflowId}/runs` },
				{ label: 'Details' }
			];
		}

		// ── /app/agents/[id]/workflows/[workflowId]/runs ──────────────────────────
		const workflowRunsMatch = pathname.match(/^\/app\/agents\/([^/]+)\/workflows\/([^/]+)\/runs$/);
		if (workflowRunsMatch) {
			const agentId = workflowRunsMatch[1];
			const workflowId = workflowRunsMatch[2];
			const agentName = agent?.name ?? 'Agent';
			const workflowName = workflow?.name ?? 'Workflow';
			return [
				{ label: 'Agents', href: '/app/agents' },
				{ label: agentName, href: `/app/workflows?agentId=${agentId}` },
				{ label: 'Workflows', href: `/app/workflows?agentId=${agentId}` },
				{
					label: workflowName,
					href: `/app/agents/${agentId}/workflows/${workflowId}/runs`
				},
				{ label: 'Runs' }
			];
		}

		// ── /app/agents/[id]/workflows/new (create or edit mode) ──────────────────
		const workflowBuilderMatch = pathname.match(/^\/app\/agents\/([^/]+)\/workflows\/new$/);
		if (workflowBuilderMatch) {
			const agentId = workflowBuilderMatch[1];
			const agentName = agent?.name ?? 'Agent';
			const isEditMode = searchParams.get('editmode') === 'true';
			if (isEditMode && workflow) {
				return [
					{ label: 'Agents', href: '/app/agents' },
					{ label: agentName, href: `/app/agents/new?id=${agentId}&editmode=true` },
					{ label: 'Workflows', href: `/app/workflows?agentId=${agentId}` },
					{ label: workflow.name }
				];
			}
			return [
				{ label: 'Agents', href: '/app/agents' },
				{ label: agentName, href: `/app/agents/new?id=${agentId}&editmode=true` },
				{ label: 'Workflows', href: `/app/workflows?agentId=${agentId}` },
				{ label: 'New Workflow' }
			];
		}

		// ── /app/agents/[id]/missions/new (create or edit mode) ──────────────────
		const missionBuilderMatch = pathname.match(/^\/app\/agents\/([^/]+)\/missions\/new$/);
		if (missionBuilderMatch) {
			const agentId = missionBuilderMatch[1];
			const agentName = agent?.name ?? 'Agent';
			const isEditMode = !!searchParams.get('id');
			return [
				{ label: 'Agents', href: '/app/agents' },
				{ label: agentName, href: `/app/agents/new?id=${agentId}&editmode=true` },
				{ label: 'Missions', href: `/app/agents/${agentId}/missions` },
				{ label: isEditMode && mission ? mission.title : 'New Mission' }
			];
		}

		// ── /app/agents/[id]/missions/[missionId] ─────────────────────────────────
		const missionDetailMatch = pathname.match(/^\/app\/agents\/([^/]+)\/missions\/([^/]+)$/);
		if (missionDetailMatch) {
			const agentId = missionDetailMatch[1];
			const agentName = agent?.name ?? 'Agent';
			return [
				{ label: 'Agents', href: '/app/agents' },
				{ label: agentName, href: `/app/agents/new?id=${agentId}&editmode=true` },
				{ label: 'Missions', href: `/app/agents/${agentId}/missions` },
				{ label: mission?.title ?? 'Mission' }
			];
		}

		// ── /app/agents/[id]/missions ─────────────────────────────────────────────
		const missionsListMatch = pathname.match(/^\/app\/agents\/([^/]+)\/missions$/);
		if (missionsListMatch) {
			const agentId = missionsListMatch[1];
			const agentName = agent?.name ?? 'Agent';
			return [
				{ label: 'Agents', href: '/app/agents' },
				{ label: agentName, href: `/app/agents/new?id=${agentId}&editmode=true` },
				{ label: 'Missions' }
			];
		}

		// ── /app/agents/new (create or edit mode) ─────────────────────────────────
		if (pathname === '/app/agents/new') {
			const isEditMode = searchParams.get('editmode') === 'true';
			if (isEditMode && agent) {
				return [{ label: 'Agents', href: '/app/agents' }, { label: agent.name }];
			}
			return [{ label: 'Agents', href: '/app/agents' }, { label: 'New Agent' }];
		}

		// ── /app/workflows ────────────────────────────────────────────────────────
		if (pathname === '/app/workflows') {
			const selectedAgentId = searchParams.get('agentId');
			const agents = ((page.data as Record<string, unknown>).agents as Agent[] | undefined) ?? [];
			const selectedAgent = selectedAgentId
				? agents.find((a) => a.id === selectedAgentId)
				: undefined;
			if (selectedAgent) {
				return [{ label: 'Workflows', href: '/app/workflows' }, { label: selectedAgent.name }];
			}
			return [{ label: 'Workflows' }];
		}

		// ── /app/knowledge ────────────────────────────────────────────────────────
		if (pathname === '/app/knowledge') {
			return [{ label: 'Knowledge' }];
		}

		// ── /app/skills ───────────────────────────────────────────────────────────
		if (pathname === '/app/skills') {
			return [{ label: 'Skills' }];
		}

		// ── /app/credentials ──────────────────────────────────────────────────────
		if (pathname === '/app/credentials') {
			return [{ label: 'Credentials' }];
		}

		// ── /app/llm-providers ────────────────────────────────────────────────────
		if (pathname === '/app/llm-providers') {
			return [{ label: 'LLM Providers' }];
		}

		// ── /app/account/* ────────────────────────────────────────────────────────
		if (pathname === '/app/account/profile') {
			return [{ label: 'Account', href: '/app/account/profile' }, { label: 'Profile' }];
		}

		if (pathname === '/app/account/api-keys') {
			return [{ label: 'Account', href: '/app/account/profile' }, { label: 'API Keys' }];
		}

		if (pathname === '/app/account/channels') {
			return [{ label: 'Account', href: '/app/account/profile' }, { label: 'Channels' }];
		}

		// ── fallback: capitalise path segments ────────────────────────────────────
		const parts = pathname.replace(/^\/app\//, '').split('/');
		const fallback: BreadcrumbSegment[] = parts.map((part: string, i: number) => {
			const label = part
				.split('-')
				.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
				.join(' ');
			const isLast = i === parts.length - 1;
			if (isLast) return { label };
			const href = '/app/' + parts.slice(0, i + 1).join('/');
			return { label, href };
		});
		return fallback;
	});
</script>

<Breadcrumb.Root>
	<Breadcrumb.List>
		{#each segments as segment, i (segment.label + i)}
			<Breadcrumb.Item class="">
				{#if segment.href}
					<Breadcrumb.Link href={segment.href} class="truncate text-xs md:text-sm">
						{segment.label}
					</Breadcrumb.Link>
				{:else}
					<Breadcrumb.Page class="truncate text-xs font-medium md:text-sm">
						{segment.label}
					</Breadcrumb.Page>
				{/if}
			</Breadcrumb.Item>
			{#if i < segments.length - 1}
				<Breadcrumb.Separator />
			{/if}
		{/each}
	</Breadcrumb.List>
</Breadcrumb.Root>
