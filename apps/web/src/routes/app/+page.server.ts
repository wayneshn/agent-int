import type { PageServerLoad } from './$types';
import { api } from '$lib/server/api';
import type {
	Agent,
	Workflow,
	CredentialMetadata,
	KnowledgeFile,
	ActivityItem,
	DashboardMissionsSummary
} from '@repo/types';

/** Fetch a single object endpoint, returning null on any failure. */
async function safeObject<T>(request: Promise<Response>): Promise<T | null> {
	try {
		const res = await request;
		const body = await res.json();
		return (body.data ?? null) as T | null;
	} catch {
		return null;
	}
}

/**
 * Run a server `api()` call and fall back to an empty list on any failure.
 * `api()` throws on non-OK responses; the dashboard aggregates several
 * independent sources, so one failing endpoint shouldn't blank the whole page.
 */
async function safeList<T>(request: Promise<Response>): Promise<T[]> {
	try {
		const res = await request;
		const body = await res.json();
		return (body.data ?? []) as T[];
	} catch {
		return [];
	}
}

/**
 * Dashboard data — all loaded in parallel. The auth guard lives in the parent
 * `app/+layout.server.ts` (redirects to /signin when unauthenticated).
 */
export const load: PageServerLoad = async (event) => {
	const [agents, workflows, credentials, knowledgeFiles, activity, missionsSummary] =
		await Promise.all([
			safeList<Agent>(api('/agents', event)),
			safeList<Workflow>(api('/workflows', event)),
			safeList<CredentialMetadata>(api('/credentials', event)),
			safeList<KnowledgeFile>(api('/knowledge/files', event)),
			safeList<ActivityItem>(api('/dashboard/activity?limit=8', event)),
			safeObject<DashboardMissionsSummary>(api('/dashboard/missions', event))
		]);

	return { agents, workflows, credentials, knowledgeFiles, activity, missionsSummary };
};
