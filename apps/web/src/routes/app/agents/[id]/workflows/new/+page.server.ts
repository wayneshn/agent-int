import { error, fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { PageServerLoad, Actions } from './$types';
import { api } from '$lib/server/api';
import type {
	Agent,
	Workflow,
	CredentialMetadata,
	CredentialDefinition,
	AppTriggerProviderInfo
} from '@repo/types';
// Server-only: the workflow-step tool catalog lives in @repo/utils (Node-only).
// It must never be imported in a .svelte/browser file — it is threaded to the
// builder components as the `toolCatalog` prop from this load instead.
// Import from the pure-data subpath (not the `@repo/utils` barrel) so the barrel's
// Node-only side effects (pino logger, node:fs registry) never enter the build —
// bundling the barrel breaks `pnpm build` (pino-pretty's worker needs `__dirname`).
import {
	BROWSER_TOOL_GROUP,
	WORKFLOW_TOOL_CATALOG,
	WORKFLOW_TOOL_CATEGORIES
} from '@repo/utils/workflow/tool-catalog';

/**
 * Unified load for workflow create and edit.
 *
 * URL params:
 *   ?workflowId=<id>&editmode=true  → edit mode: fetches the existing workflow
 *   (no params)                     → create mode
 */
export const load: PageServerLoad = async (event) => {
	const { id: agentId } = event.params;
	const ownerId = event.locals.user?.id;
	const workflowId = event.url.searchParams.get('workflowId');
	const isEditMode = event.url.searchParams.get('editmode') === 'true' && !!workflowId;

	if (!ownerId) {
		error(401, 'Not authenticated');
	}

	// Always need the agent + credentials + definitions + app-trigger catalog in parallel
	const [agentRes, credsRes, defsRes, appTriggersRes] = await Promise.all([
		api(`/agents/${agentId}`, event),
		api('/credentials', event),
		api('/credentials/definitions', event),
		api('/app-triggers/providers', event)
	]);

	if (!agentRes.ok) {
		error(404, 'Agent not found');
	}

	const agentBody = await agentRes.json();
	const agent = agentBody.data as Agent;

	// All of the owner's credentials — app triggers authenticate the listener with any
	// credential of the matching type, not just agent-linked ones.
	let allCredentials: CredentialMetadata[] = [];
	if (credsRes.ok) {
		const credsBody = await credsRes.json();
		allCredentials = (credsBody.data ?? []) as CredentialMetadata[];
	}
	// Step cards expose the credentials available to this agent. When the agent is
	// flagged to use all credentials, that's every owner credential (current + future);
	// otherwise just the ones explicitly linked to the agent.
	const agentCredentialIds = new Set(agent.credentialIds);
	const credentials = agent.allCredentials
		? allCredentials
		: allCredentials.filter((c) => agentCredentialIds.has(c.id));

	let definitions: CredentialDefinition[] = [];
	if (defsRes.ok) {
		const defsBody = await defsRes.json();
		definitions = (defsBody.data ?? []) as CredentialDefinition[];
	}

	let appTriggerProviders: AppTriggerProviderInfo[] = [];
	if (appTriggersRes.ok) {
		const appBody = await appTriggersRes.json();
		appTriggerProviders = (appBody.data ?? []) as AppTriggerProviderInfo[];
	}

	// Edit mode: also fetch the existing workflow
	let workflow: Workflow | null = null;
	if (isEditMode && workflowId) {
		const workflowRes = await api(`/agents/${agentId}/workflows/${workflowId}`, event);
		if (!workflowRes.ok) {
			error(404, 'Workflow not found');
		}
		const workflowBody = await workflowRes.json();
		workflow = workflowBody.data as Workflow;
	}

	// Gate the workflow builder's "Agent Browser" tool group the same way chat does:
	// the agent must allow internet access AND the deployment must enable the feature.
	const browserAvailable = agent.allowInternetAccess && env.BROWSER_FEATURE_ENABLED === 'true';

	return {
		agent,
		credentials,
		allCredentials,
		definitions,
		appTriggerProviders,
		browserAvailable,
		// Tool picker catalog (from @repo/utils) — passed down so browser code never
		// imports the Node-only package directly.
		toolCatalog: {
			catalog: WORKFLOW_TOOL_CATALOG,
			categories: WORKFLOW_TOOL_CATEGORIES,
			browserToolGroup: BROWSER_TOOL_GROUP
		},
		workflow,
		isEditMode
	};
};

/**
 * Pull a flat list of human-readable validation messages from a 422 error body.
 * Prefers the backend's path-annotated `messages`, falls back to raw Zod `issues`.
 */
function extractMessages(body: unknown): string[] {
	const b = body as { messages?: unknown; issues?: { path?: string; message?: string }[] };
	if (Array.isArray(b.messages)) {
		return b.messages.filter((m): m is string => typeof m === 'string');
	}
	if (Array.isArray(b.issues)) {
		return b.issues.map((i) =>
			i.path ? `${i.path}: ${i.message}` : (i.message ?? 'Invalid value')
		);
	}
	return [];
}

// ─── Form Actions ─────────────────────────────────────────────────────────────

export const actions: Actions = {
	/**
	 * Save action for both create and edit modes.
	 *
	 * Form fields:
	 *   - workflowId (present in edit mode)
	 *   - workflowJson: the full serialised workflow as a JSON string
	 */
	save: async (event) => {
		const ownerId = event.locals.user?.id;
		if (!ownerId) {
			return fail(401, { error: 'Not authenticated' });
		}

		const { id: agentId } = event.params;
		const formData = await event.request.formData();
		const workflowId = formData.get('workflowId') as string | null;
		const isEditMode = !!workflowId;
		const workflowJson = formData.get('workflowJson') as string | null;

		if (!workflowJson) {
			return fail(400, { error: 'Workflow data is missing.' });
		}

		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(workflowJson) as Record<string, unknown>;
		} catch {
			return fail(400, { error: 'Invalid workflow JSON.' });
		}

		if (isEditMode) {
			const res = await api(`/agents/${agentId}/workflows/${workflowId}`, event, {
				method: 'PUT',
				body: JSON.stringify(payload)
			});

			if (!res.ok) {
				const body = await res.json();
				// Surface ALL validation problems (path-annotated) so the user can fix them.
				const messages = extractMessages(body);
				if (messages.length > 0) {
					return fail(res.status, { error: messages.join('\n'), messages });
				}
				return fail(res.status, { error: body.error ?? 'Failed to update workflow' });
			}
		} else {
			const res = await api(`/agents/${agentId}/workflows`, event, {
				method: 'POST',
				body: JSON.stringify(payload)
			});

			if (!res.ok) {
				const body = await res.json();
				const messages = extractMessages(body);
				if (messages.length > 0) {
					return fail(res.status, { error: messages.join('\n'), messages });
				}
				return fail(res.status, { error: body.error ?? 'Failed to create workflow' });
			}

			const body = await res.json();
			const newId = (body.data as Workflow).id;

			// Redirect to edit mode so user can keep editing
			redirect(
				303,
				`/app/agents/${agentId}/workflows/new?workflowId=${encodeURIComponent(newId)}&editmode=true&saved=true`
			);
		}

		// Edit-mode redirect
		redirect(
			303,
			`/app/agents/${agentId}/workflows/new?workflowId=${encodeURIComponent(workflowId!)}&editmode=true&saved=true`
		);
	}
};
