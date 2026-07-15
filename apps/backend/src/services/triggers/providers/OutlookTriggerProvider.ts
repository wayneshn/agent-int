import type { AppTriggerParamField } from '@repo/types';
import { logger } from '../../../config/logger.js';
import {
	readErrorExcerpt,
	type AppTriggerProviderContext,
	type NormalizedAppEvent,
} from '../AppTriggerProvider.js';
import { EmailPollingTriggerProvider, MAX_LIST_IDS, buildEmailEvent } from '../emailPolling.js';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_API_BASE = `${GRAPH_ORIGIN}/v1.0/me`;

interface GraphRecipient {
	emailAddress?: { name?: string; address?: string };
}

interface GraphMessageListItem {
	id: string;
}

interface GraphMessageList {
	value?: GraphMessageListItem[];
	'@odata.nextLink'?: string;
}

interface GraphMessage {
	id: string;
	conversationId?: string;
	subject?: string;
	bodyPreview?: string;
	receivedDateTime?: string;
	from?: GraphRecipient;
	toRecipients?: GraphRecipient[];
	categories?: string[];
	body?: { contentType?: string; content?: string };
}

/**
 * Outlook / Hotmail app trigger — polls Microsoft Graph for new mail.
 *
 * Outlook.com, Hotmail, and Live mailboxes all speak the same Microsoft Graph mail API, so a
 * single provider covers them via the shared `microsoft-outlook` credential. Like Gmail, this
 * is polling (Graph does support change notifications/webhooks, but those need a public HTTPS
 * endpoint + subscription renewal — polling needs only the OAuth token), reusing the generic
 * {@link EmailPollingTriggerProvider} core. This class only supplies the Graph list/fetch calls.
 */
export class OutlookTriggerProvider extends EmailPollingTriggerProvider {
	readonly id = 'outlook';
	readonly displayName = 'Outlook / Hotmail';
	readonly icon = '/logos/microsoft-outlook.svg';
	readonly compatibleCredentialTypes = ['microsoft-outlook'];
	readonly setupNote =
		'Polls Outlook/Hotmail on an interval — no public URL required. ' +
		'Requires a Microsoft Outlook credential with the Mail.Read scope.';

	protected eventParams(): AppTriggerParamField[] {
		return [
			{
				name: 'folder',
				label: 'Mail folder',
				type: 'string',
				required: false,
				description:
					'Well-known folder name (e.g. inbox, junkemail) or a folder id. Defaults to inbox.',
				placeholder: 'inbox',
				default: 'inbox',
			},
		];
	}

	// ─── Adapter implementation ──────────────────────────────────────────────

	protected async listSince(
		ctx: AppTriggerProviderContext,
		params: Record<string, unknown>,
		watermark: string,
	): Promise<string[]> {
		// Graph `$filter ... ge` is inclusive at the boundary — the core's seenIds set removes
		// repeats. Order newest-first; the core owns the fetch budget.
		const firstUrl = `${GRAPH_API_BASE}/mailFolders/${this.resolveFolder(params)}/messages`;
		const firstQs: Record<string, string> = {
			$filter: `receivedDateTime ge ${watermark}`,
			$orderby: 'receivedDateTime desc',
			$top: '100',
			$select: 'id',
		};

		// Page to exhaustion so a burst larger than one page still enters the core's overflow
		// queue. Graph returns an absolute `@odata.nextLink` (which already encodes $skiptoken +
		// the original query) — follow it verbatim, but origin-check it first (SSRF guard).
		const ids: string[] = [];
		let next: { url: string; qs?: Record<string, string> } | undefined = {
			url: firstUrl,
			qs: firstQs,
		};
		while (next) {
			const response = await ctx.execute({ method: 'GET', url: next.url, qs: next.qs });
			if (!response.ok) {
				const excerpt = await readErrorExcerpt(response);
				throw new Error(`Outlook messages.list failed (${response.status}): ${excerpt}`);
			}
			const body = (await response.json()) as GraphMessageList;
			for (const m of body.value ?? []) ids.push(m.id);

			const nextLink = body['@odata.nextLink'];
			if (ids.length >= MAX_LIST_IDS) {
				if (nextLink) {
					logger.warn(
						{ provider: this.id, listed: ids.length },
						'[app-trigger] Outlook list hit MAX_LIST_IDS cap — older messages this cycle are skipped',
					);
				}
				return ids.slice(0, MAX_LIST_IDS);
			}
			next = nextLink && this.isGraphUrl(nextLink) ? { url: nextLink } : undefined;
		}
		return ids;
	}

	protected async listLatestIds(
		ctx: AppTriggerProviderContext,
		params: Record<string, unknown>,
	): Promise<string[]> {
		// Newest messages, no time filter, single page.
		const url = `${GRAPH_API_BASE}/mailFolders/${this.resolveFolder(params)}/messages`;
		const qs: Record<string, string> = {
			$orderby: 'receivedDateTime desc',
			$top: '10',
			$select: 'id',
		};
		const response = await ctx.execute({ method: 'GET', url, qs });
		if (!response.ok) {
			const excerpt = await readErrorExcerpt(response);
			throw new Error(`Outlook messages.list failed (${response.status}): ${excerpt}`);
		}
		const body = (await response.json()) as GraphMessageList;
		return (body.value ?? []).map((m) => m.id);
	}

	/** Only follow a Graph-issued nextLink that stays on the Graph origin (SSRF guard). */
	private isGraphUrl(url: string): boolean {
		try {
			return new URL(url).origin === GRAPH_ORIGIN;
		} catch {
			return false;
		}
	}

	protected async fetchAndNormalize(
		ctx: AppTriggerProviderContext,
		id: string,
	): Promise<NormalizedAppEvent | null> {
		const response = await ctx.execute({
			method: 'GET',
			url: `${GRAPH_API_BASE}/messages/${encodeURIComponent(id)}`,
		});
		if (response.status === 404) return null; // moved/deleted between list + fetch
		if (!response.ok) {
			const excerpt = await readErrorExcerpt(response);
			throw new Error(`Outlook messages.get failed (${response.status}): ${excerpt}`);
		}
		const message = (await response.json()) as GraphMessage;

		// Undefined when absent (Graph always sets receivedDateTime) — never fabricate `now`, or
		// the core would ratchet the watermark forward and skip unfetched older mail.
		const receivedAt = message.receivedDateTime;
		const to = (message.toRecipients ?? [])
			.map((r) => r.emailAddress?.address ?? '')
			.filter(Boolean)
			.join(', ');
		return buildEmailEvent({
			id: message.id,
			occurredAt: receivedAt,
			from: message.from?.emailAddress?.address ?? '',
			to,
			subject: message.subject ?? '',
			snippet: message.bodyPreview ?? '',
			body: message.body?.content ?? '',
			threadId: message.conversationId,
			labels: message.categories ?? [],
			raw: message,
		});
	}

	/** Resolve + guard the folder path segment against injection (well-known name or id). */
	private resolveFolder(params: Record<string, unknown>): string {
		const folder = typeof params.folder === 'string' ? params.folder.trim() : '';
		if (!folder) return 'inbox';
		// Well-known names (inbox, junkemail…) are alphanumeric; real Graph folder ids are
		// base64url and routinely carry `=` padding. Allow that charset and reject anything
		// else; encodeURIComponent (applied below) escapes the segment either way (SSRF guard).
		if (!/^[A-Za-z0-9_=-]+$/.test(folder)) {
			throw new Error(`Invalid Outlook mail folder: ${folder}`);
		}
		return encodeURIComponent(folder);
	}
}
