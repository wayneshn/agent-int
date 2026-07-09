import { fail, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { api } from '$lib/server/api';
import { error } from '@sveltejs/kit';
import type {
	Agent,
	AgentEvolvedSkill,
	AgentKnowledgeAssignment,
	CredentialMetadata,
	CredentialDefinition,
	LlmProviderConfig,
	McpServer
} from '@repo/types';

/**
 * Unified load function for both create and edit modes.
 *
 * URL params:
 *   ?id=<agentId>&editmode=true  → edit mode: fetches existing agent data
 *   (no params)                  → create mode: fetches supporting data only
 */
export const load: PageServerLoad = async (event) => {
	const ownerId = event.locals.user?.id;
	const agentId = event.url.searchParams.get('id');
	const isEditMode = event.url.searchParams.get('editmode') === 'true' && !!agentId;

	if (!ownerId) {
		error(401, 'Not authenticated');
	}

	// Always fetch supporting data in parallel
	// Note: skill catalog is NOT loaded here — the AgentSkillsPanel component
	// fetches it lazily when the "Add skill" dialog is opened.
	// The agents list powers the collaborators (agent-to-agent) panel.
	const [credsRes, defsRes, llmRes, agentsRes, mcpRes] = await Promise.all([
		api('/credentials', event),
		api('/credentials/definitions', event),
		api('/llm-providers', event),
		api('/agents', event),
		api('/mcp-servers', event)
	]);

	let credentials: CredentialMetadata[] = [];
	if (credsRes.ok) {
		const body = await credsRes.json();
		credentials = (body.data ?? []) as CredentialMetadata[];
	}

	let definitions: CredentialDefinition[] = [];
	if (defsRes.ok) {
		const body = await defsRes.json();
		definitions = (body.data ?? []) as CredentialDefinition[];
	}

	let llmConfigs: LlmProviderConfig[] = [];
	if (llmRes.ok) {
		const body = await llmRes.json();
		llmConfigs = (body.data ?? []) as LlmProviderConfig[];
	}

	// Candidate agents for the collaborators panel (the current agent is excluded
	// client-side in edit mode). Only display metadata is needed here.
	let agents: Array<{ id: string; name: string; description?: string; avatarUrl?: string }> = [];
	if (agentsRes.ok) {
		const body = await agentsRes.json();
		agents = ((body.data ?? []) as Agent[]).map((a) => ({
			id: a.id,
			name: a.name,
			description: a.description,
			avatarUrl: a.avatarUrl
		}));
	}

	// Owner's MCP servers — powers the agent's MCP assignment panel.
	let mcpServers: McpServer[] = [];
	if (mcpRes.ok) {
		const body = await mcpRes.json();
		mcpServers = (body.data ?? []) as McpServer[];
	}

	// Edit mode — additionally fetch agent, assigned skills, evolved skills,
	// knowledge assignments, and assigned MCP server ids
	let agent: Agent | null = null;
	let assignedSkillNames: string[] = [];
	const evolvedSkills: Record<string, AgentEvolvedSkill> = {};
	let knowledgeAssignments: AgentKnowledgeAssignment[] = [];
	let assignedMcpServerIds: string[] = [];

	if (isEditMode) {
		const [agentRes, agentSkillsRes, evolvedRes, knowledgeRes, mcpAssignRes] = await Promise.all([
			api(`/agents/${agentId}`, event),
			api(`/agents/${agentId}/skills`, event),
			api(`/agents/${agentId}/skills/evolved`, event),
			api(`/agents/${agentId}/knowledge`, event),
			api(`/mcp-servers/agent/${agentId}`, event)
		]);

		if (!agentRes.ok) {
			error(404, 'Agent not found');
		}

		const agentBody = await agentRes.json();
		agent = agentBody.data as Agent;

		if (agentSkillsRes.ok) {
			const body = await agentSkillsRes.json();
			assignedSkillNames = (body.data ?? []) as string[];
		}

		if (evolvedRes.ok) {
			const body = await evolvedRes.json();
			for (const evolved of (body.data ?? []) as AgentEvolvedSkill[]) {
				evolvedSkills[evolved.skillName] = evolved;
			}
		}

		if (knowledgeRes.ok) {
			const body = await knowledgeRes.json();
			knowledgeAssignments = (body.data ?? []) as AgentKnowledgeAssignment[];
		}

		if (mcpAssignRes.ok) {
			const body = await mcpAssignRes.json();
			assignedMcpServerIds = (body.data ?? []) as string[];
		}
	}

	return {
		isEditMode,
		agent,
		credentials,
		definitions,
		llmConfigs,
		agents,
		mcpServers,
		assignedSkillNames,
		evolvedSkills,
		knowledgeAssignments,
		assignedMcpServerIds
	};
};

// ─── Form Actions ─────────────────────────────────────────────────────────────

export const actions: Actions = {
	/**
	 * Unified save action for both create and edit modes.
	 *
	 * Form fields:
	 *   - name, description, systemInstruction, avatarUrl
	 *   - modelConfigId, embeddingModelConfigId
	 *   - credentialIds (repeated field, one per selected credential)
	 *   - skillNames (repeated field, one per selected skill)
	 *   - agentId (present in edit mode only)
	 *
	 * Two-step process:
	 *   1. Create or update the agent to get a stable agentId
	 *   2. Sync skill assignments: remove skills not in the new list, add new ones
	 */
	save: async (event) => {
		const ownerId = event.locals.user?.id;
		if (!ownerId) {
			return fail(401, { error: 'Not authenticated' });
		}

		const formData = await event.request.formData();

		const agentId = formData.get('agentId') as string | null;
		const isEditMode = !!agentId;

		const name = (formData.get('name') as string | null)?.trim();
		if (!name) {
			return fail(400, { error: 'Name is required' });
		}

		const description = (formData.get('description') as string | null)?.trim() || null;
		const systemInstruction = (formData.get('systemInstruction') as string | null)?.trim() || null;
		const avatarUrl = (formData.get('avatarUrl') as string | null) || '🤖';
		const modelConfigId = (formData.get('modelConfigId') as string | null) || null;
		const embeddingModelConfigId =
			(formData.get('embeddingModelConfigId') as string | null) || null;
		const credentialIds = formData.getAll('credentialIds') as string[];
		const collaboratorIds = formData.getAll('collaboratorIds') as string[];
		const allCredentials = formData.get('allCredentials') === 'true';
		const skillNames = formData.getAll('skillNames') as string[];
		const knowledgeFileIds = formData.getAll('knowledgeFileIds') as string[];
		const mcpServerIds = formData.getAll('mcpServerIds') as string[];
		const allowInternetAccess = formData.get('allowInternetAccess') !== 'false';
		// Clamp to the same 1–100 range the backend enforces; fall back to 20 on non-numeric input.
		const rawMaxToolCalls = Number(formData.get('maxToolCallsPerTurn'));
		const maxToolCallsPerTurn = Number.isFinite(rawMaxToolCalls)
			? Math.min(100, Math.max(1, Math.round(rawMaxToolCalls)))
			: 20;

		// Step 1: Create or update agent
		let savedAgentId: string;
		if (isEditMode) {
			const res = await api(`/agents/${agentId}`, event, {
				method: 'PUT',
				body: JSON.stringify({
					name,
					description,
					systemInstruction,
					avatarUrl,
					credentialIds,
					collaboratorIds,
					allCredentials,
					modelConfigId,
					embeddingModelConfigId,
					allowInternetAccess,
					maxToolCallsPerTurn
				})
			});

			if (!res.ok) {
				const body = await res.json();
				return fail(res.status, { error: body.error ?? 'Failed to update agent' });
			}

			savedAgentId = agentId;
		} else {
			const res = await api('/agents', event, {
				method: 'POST',
				body: JSON.stringify({
					name,
					description,
					systemInstruction,
					avatarUrl,
					credentialIds,
					collaboratorIds,
					allCredentials,
					modelConfigId,
					embeddingModelConfigId,
					allowInternetAccess,
					maxToolCallsPerTurn
				})
			});

			if (!res.ok) {
				const body = await res.json();
				return fail(res.status, { error: body.error ?? 'Failed to create agent' });
			}

			const body = await res.json();
			savedAgentId = (body.data as Agent).id;
		}

		// Step 2: Sync skill assignments
		// Fetch currently assigned skills so we can diff
		const currentSkillsRes = await api(`/agents/${savedAgentId}/skills`, event);
		const currentSkills: string[] = currentSkillsRes.ok
			? ((await currentSkillsRes.json()).data ?? [])
			: [];

		const toAdd = skillNames.filter((s) => !currentSkills.includes(s));
		const toRemove = currentSkills.filter((s) => !skillNames.includes(s));

		// Execute adds and removes in parallel — best-effort (don't fail the whole action on skill errors)
		await Promise.allSettled([
			...toAdd.map((skillName) =>
				api(`/agents/${savedAgentId}/skills`, event, {
					method: 'POST',
					body: JSON.stringify({ skillName })
				})
			),
			...toRemove.map((skillName) =>
				api(`/agents/${savedAgentId}/skills/${encodeURIComponent(skillName)}`, event, {
					method: 'DELETE'
				})
			)
		]);

		// Step 3: Sync knowledge assignments (same diff pattern as skills).
		// Assignment ingestion (chunk + embed) runs server-side in the background.
		const currentKnowledgeRes = await api(`/agents/${savedAgentId}/knowledge`, event);
		const currentAssignments: AgentKnowledgeAssignment[] = currentKnowledgeRes.ok
			? (((await currentKnowledgeRes.json()).data ?? []) as AgentKnowledgeAssignment[])
			: [];

		const currentFileIds = currentAssignments.map((a) => a.knowledgeFileId);
		const knowledgeToAdd = knowledgeFileIds.filter((id) => !currentFileIds.includes(id));
		const assignmentsToRemove = currentAssignments.filter(
			(a) => !knowledgeFileIds.includes(a.knowledgeFileId)
		);

		await Promise.allSettled([
			...(knowledgeToAdd.length > 0
				? [
						api(`/agents/${savedAgentId}/knowledge`, event, {
							method: 'POST',
							body: JSON.stringify({ knowledgeFileIds: knowledgeToAdd })
						})
					]
				: []),
			...assignmentsToRemove.map((assignment) =>
				api(`/agents/${savedAgentId}/knowledge/${assignment.id}`, event, {
					method: 'DELETE'
				})
			)
		]);

		// Step 4: Replace MCP server assignments (server-side replace — the backend
		// filters to owned servers and delete-then-reinserts the junction).
		await api(`/mcp-servers/agent/${savedAgentId}`, event, {
			method: 'PUT',
			body: JSON.stringify({ mcpServerIds })
		});

		// Redirect to edit mode of the saved agent so the user can see the result
		redirect(
			303,
			`/app/agents/new?id=${encodeURIComponent(savedAgentId)}&editmode=true&saved=true`
		);
	}
};
