import type { AppTriggerParamField } from '@repo/types';
import { logger } from '../../../config/logger.js';
import {
	readErrorExcerpt,
	type AppTriggerProviderContext,
	type AppTriggerResourceListResult,
	type NormalizedAppEvent,
} from '../AppTriggerProvider.js';
import { EmailPollingTriggerProvider, MAX_LIST_IDS, buildEmailEvent } from '../emailPolling.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailListMessage {
	id: string;
	threadId?: string;
}

interface GmailMessageList {
	messages?: GmailListMessage[];
	nextPageToken?: string;
}

interface GmailMessage {
	id: string;
	threadId?: string;
	labelIds?: string[];
	snippet?: string;
	internalDate?: string;
	payload?: GmailMessagePart;
}

interface GmailMessagePart {
	mimeType?: string;
	headers?: { name: string; value: string }[];
	body?: { data?: string; size?: number };
	parts?: GmailMessagePart[];
}

/**
 * Gmail app trigger — polls the Gmail REST API for new messages.
 *
 * Delivery is polling, not push: each cycle lists messages with `q=after:<lastSeen>` and
 * fetches the new ones. This needs only an OAuth token — no Google Cloud Pub/Sub topic, no
 * public HTTPS endpoint, and no 7-day `watch` renewal — so it works on localhost and is
 * testable without any external infrastructure. Latency is one poll interval.
 *
 * All the polling machinery (durable cursor, inclusive-boundary dedup, fetch budget,
 * first-run baselining) lives in the shared {@link EmailPollingTriggerProvider} core; this
 * class only supplies the Gmail-specific list/fetch calls and the label picker.
 */
export class GmailTriggerProvider extends EmailPollingTriggerProvider {
	readonly id = 'gmail';
	readonly displayName = 'Gmail';
	readonly icon = '/logos/gmail.svg';
	readonly compatibleCredentialTypes = ['gmail', 'googleWorkspaceOAuth2'];
	readonly setupNote =
		'Polls Gmail on an interval. ' +
		'Requires a Gmail credential; the gmail.readonly scope is enough for the trigger.';

	protected eventParams(): AppTriggerParamField[] {
		return [
			{
				name: 'labelId',
				label: 'Label filter',
				type: 'resource',
				resource: { type: 'gmail-label', searchable: true },
				required: false,
				description: 'Only watch this Gmail label (e.g. INBOX). Leave blank for all mail.',
				placeholder: 'All mail',
			},
		];
	}

	async listResources(
		ctx: AppTriggerProviderContext,
		resourceType: string,
		query: { search?: string; cursor?: string },
	): Promise<AppTriggerResourceListResult> {
		if (resourceType !== 'gmail-label') return { options: [] };
		const response = await ctx.execute({ method: 'GET', url: `${GMAIL_API_BASE}/labels` });
		if (!response.ok) {
			const excerpt = await readErrorExcerpt(response);
			throw new Error(`Gmail labels.list failed (${response.status}): ${excerpt}`);
		}
		const body = (await response.json()) as { labels?: { id: string; name: string }[] };
		// labels.list has no query param and returns a small set — filter client-side, no paging.
		const term = (query.search ?? '').toLowerCase();
		const options = (body.labels ?? [])
			.filter((label) => !term || label.name.toLowerCase().includes(term))
			.map((label) => ({ value: label.id, label: label.name }));
		return { options };
	}

	// ─── Adapter implementation ──────────────────────────────────────────────

	protected async listSince(
		ctx: AppTriggerProviderContext,
		params: Record<string, unknown>,
		watermark: string,
	): Promise<string[]> {
		// Gmail search `after:` is Unix-seconds granular and inclusive at the boundary — the
		// core's seenIds set removes any repeats. `-in:chats` excludes Google Chat messages.
		const terms = ['-in:chats'];
		const epochSec = Math.floor(Date.parse(watermark) / 1000);
		if (!Number.isNaN(epochSec)) terms.push(`after:${epochSec}`);

		const baseQs: Record<string, string> = { q: terms.join(' '), maxResults: '100' };
		const labelId = typeof params.labelId === 'string' ? params.labelId.trim() : '';
		if (labelId) baseQs.labelIds = labelId;

		// Page to exhaustion so a burst larger than one page still enters the core's overflow
		// queue; the MAX_LIST_IDS cap bounds the persisted state, and hitting it is logged (not
		// silent) since the oldest ids beyond it would be dropped.
		const ids: string[] = [];
		let pageToken: string | undefined;
		do {
			const qs = pageToken ? { ...baseQs, pageToken } : baseQs;
			const response = await ctx.execute({ method: 'GET', url: `${GMAIL_API_BASE}/messages`, qs });
			if (!response.ok) {
				const excerpt = await readErrorExcerpt(response);
				throw new Error(`Gmail messages.list failed (${response.status}): ${excerpt}`);
			}
			const body = (await response.json()) as GmailMessageList;
			for (const m of body.messages ?? []) ids.push(m.id);
			pageToken = body.nextPageToken;
			if (ids.length >= MAX_LIST_IDS) {
				if (pageToken) {
					logger.warn(
						{ provider: this.id, listed: ids.length },
						'[app-trigger] Gmail list hit MAX_LIST_IDS cap — older messages this cycle are skipped',
					);
				}
				return ids.slice(0, MAX_LIST_IDS);
			}
		} while (pageToken);
		return ids;
	}

	protected async listLatestIds(
		ctx: AppTriggerProviderContext,
		params: Record<string, unknown>,
	): Promise<string[]> {
		// Newest messages, no time filter (an `after:0` returns nothing), single page.
		const qs: Record<string, string> = { q: '-in:chats', maxResults: '10' };
		const labelId = typeof params.labelId === 'string' ? params.labelId.trim() : '';
		if (labelId) qs.labelIds = labelId;

		const response = await ctx.execute({ method: 'GET', url: `${GMAIL_API_BASE}/messages`, qs });
		if (!response.ok) {
			const excerpt = await readErrorExcerpt(response);
			throw new Error(`Gmail messages.list failed (${response.status}): ${excerpt}`);
		}
		const body = (await response.json()) as GmailMessageList;
		return (body.messages ?? []).map((m) => m.id);
	}

	protected async fetchAndNormalize(
		ctx: AppTriggerProviderContext,
		id: string,
	): Promise<NormalizedAppEvent | null> {
		const response = await ctx.execute({
			method: 'GET',
			url: `${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}`,
			qs: { format: 'full' },
		});
		if (response.status === 404) return null; // deleted between list + fetch
		if (!response.ok) {
			const excerpt = await readErrorExcerpt(response);
			throw new Error(`Gmail messages.get failed (${response.status}): ${excerpt}`);
		}
		const message = (await response.json()) as GmailMessage;

		const headers = message.payload?.headers ?? [];
		const header = (name: string): string =>
			headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
		// Undefined when absent (Gmail always sets internalDate) — never fabricate `now`, or the
		// core would ratchet the watermark forward and skip unfetched older mail.
		const receivedAt = message.internalDate
			? new Date(Number(message.internalDate)).toISOString()
			: undefined;
		return buildEmailEvent({
			id: message.id,
			occurredAt: receivedAt,
			from: header('From'),
			to: header('To'),
			subject: header('Subject'),
			snippet: message.snippet ?? '',
			body: this.extractBody(message.payload),
			threadId: message.threadId,
			labels: message.labelIds ?? [],
			raw: message,
		});
	}

	/** Depth-first search for the first text/plain (then text/html) body part. */
	private extractBody(part: GmailMessagePart | undefined): string {
		if (!part) return '';
		const decode = (data?: string): string =>
			data ? Buffer.from(data, 'base64url').toString('utf-8') : '';

		const find = (node: GmailMessagePart, mime: string): string | null => {
			if (node.mimeType === mime && node.body?.data) return decode(node.body.data);
			for (const child of node.parts ?? []) {
				const found = find(child, mime);
				if (found) return found;
			}
			return null;
		};

		return find(part, 'text/plain') ?? find(part, 'text/html') ?? decode(part.body?.data);
	}
}
