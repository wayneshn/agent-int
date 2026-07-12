import type { AppTriggerEventInfo, AppTriggerParamField, AppTriggerState } from '@repo/types';
import { logger } from '../../config/logger.js';
import type {
	AppTriggerPollResult,
	AppTriggerProvider,
	AppTriggerProviderContext,
	AppTriggerResourceListResult,
	NormalizedAppEvent,
} from './AppTriggerProvider.js';

/**
 * Generic email-polling core — the reusable engine behind every "fire a workflow when a
 * new email arrives" provider (Gmail, Outlook/Hotmail, and any future IMAP-style service).
 *
 * Modeled on n8n's polling Gmail trigger, adapted to this codebase's `poll()` contract
 * (state in → events + stateUpdate out; AppTriggerManager owns all persistence). A mail
 * service implements the small `EmailPollAdapter` (list ids since a watermark + fetch one
 * message); this module owns the hard parts that are identical across services:
 *   - a durable timestamp cursor so "new" survives restarts and never replays history,
 *   - inclusive-boundary deduplication (timestamps aren't unique; range filters repeat),
 *   - a per-poll fetch budget with an overflow queue (a burst can't blow up one poll),
 *   - first-run baselining (activation records "now" instead of flooding old mail).
 *
 * Add a new mail service = one thin `EmailPollingTriggerProvider` subclass + one registry line.
 */

/** Max messages fetched per poll cycle; the rest are queued and drained next tick. */
export const MAX_PER_POLL = 25;

/**
 * Upper bound on ids a single `listSince` paginates through, so a huge backlog (long
 * downtime) can't grow the persisted `pending` array without limit. Adapters that hit this
 * cap MUST log a warning — the oldest ids beyond it would otherwise be dropped silently.
 */
export const MAX_LIST_IDS = 1000;

/** Minimum poll cadence for email providers (Gmail/Graph quota-friendly, matches Forms). */
export const MIN_EMAIL_POLL_INTERVAL_SEC = 60;

/**
 * Structured value persisted in `AppTriggerState.cursor` (typed `unknown`, so this needs
 * no shared-type change). Owned entirely by this core.
 */
export interface EmailPollCursor {
	/** ISO-8601 timestamp of the newest email seen so far — the high-water mark. */
	watermark: string;
	/**
	 * Ids of messages emitted at the watermark boundary. Range filters (Gmail `after:`,
	 * Graph `ge`) are inclusive at the second/instant, so these are filtered out next poll
	 * to turn at-least-once into exactly-once.
	 */
	seenIds: string[];
	/** Overflow ids listed but not yet fetched (backpressure) — drained before listing anew. */
	pending: string[];
}

/**
 * The per-service contract the core drives. A mail provider implements exactly these two
 * calls against its own authenticated API via the credential-bound `ctx.execute`.
 */
export interface EmailPollAdapter {
	/**
	 * List ids of every message in the SECOND of `watermark` and later, newest first, using
	 * server-side filtering. `watermark` is already floored to the whole second by the core, so
	 * the query must be inclusive from that second (Gmail `after:<sec>`, Graph `receivedDateTime
	 * ge <sec>`) — the core's second-granular `seenIds` de-dups the re-listed boundary second.
	 * Returning a single page is fine; the core applies dedup + the fetch budget on top.
	 */
	listSince(
		ctx: AppTriggerProviderContext,
		params: Record<string, unknown>,
		watermark: string,
	): Promise<string[]>;

	/**
	 * Fetch one message by id and map it to the shared normalized email payload. `occurredAt`
	 * MUST be the message's received time (ISO-8601) — it drives the watermark. Returns null
	 * if the message vanished between listing and fetching (deleted/moved).
	 */
	fetchAndNormalize(ctx: AppTriggerProviderContext, id: string): Promise<NormalizedAppEvent | null>;
}

/** Runtime type-guard: is a persisted `state.cursor` a valid EmailPollCursor? */
function isEmailPollCursor(value: unknown): value is EmailPollCursor {
	if (typeof value !== 'object' || value === null) return false;
	const c = value as Record<string, unknown>;
	return typeof c.watermark === 'string' && Array.isArray(c.seenIds) && Array.isArray(c.pending);
}

/** Compare two ISO-8601 timestamps; returns the later one as a string. */
function laterIso(a: string, b: string): string {
	return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Floor an ISO-8601 timestamp to whole seconds. The dedup boundary is computed at second
 * granularity because that is the coarsest query granularity across providers (Gmail's
 * `after:` is second-granular and re-lists the entire second, even though `internalDate`
 * is millisecond-precise) — so every id in the watermark's second must be de-duplicated,
 * not just the ids matching the exact millisecond.
 */
function toEpochSec(iso: string): number {
	return Math.floor(Date.parse(iso) / 1000);
}

/** Floor an ISO-8601 timestamp to the whole second, as an ISO string. */
function floorIsoToSecond(iso: string): string {
	return new Date(toEpochSec(iso) * 1000).toISOString();
}

/**
 * The polling algorithm. Given an adapter and the trigger's persisted state, returns the
 * new email events to fire plus the cursor patch the manager persists.
 */
export async function runEmailPoll(
	adapter: EmailPollAdapter,
	ctx: AppTriggerProviderContext,
	params: Record<string, unknown>,
	state: AppTriggerState,
): Promise<AppTriggerPollResult> {
	const now = new Date().toISOString();
	const existing = isEmailPollCursor(state.cursor) ? state.cursor : undefined;

	// First run (or a legacy/foreign cursor, e.g. an old Gmail Pub/Sub historyId): baseline at
	// "now" so only mail arriving AFTER activation counts. No list/fetch — never replay history.
	if (!existing) {
		const cursor: EmailPollCursor = { watermark: now, seenIds: [], pending: [] };
		return { events: [], stateUpdate: { cursor, lastPolledAt: now } };
	}

	// Drain overflow from the previous poll first (backpressure); otherwise list fresh.
	let toFetch: string[];
	let pending: string[];
	if (existing.pending.length > 0) {
		toFetch = existing.pending.slice(0, MAX_PER_POLL);
		pending = existing.pending.slice(MAX_PER_POLL);
	} else {
		const seen = new Set(existing.seenIds);
		// Floor the watermark to the second so the adapter re-lists the ENTIRE boundary second
		// (matching the second-granular seenIds); otherwise a ms-precise `ge`/`after:` would skip
		// a same-second message that only became queryable after the watermark advanced.
		const listed = await adapter.listSince(ctx, params, floorIsoToSecond(existing.watermark));
		const fresh = listed.filter((id) => !seen.has(id));
		toFetch = fresh.slice(0, MAX_PER_POLL);
		pending = fresh.slice(MAX_PER_POLL);
	}

	if (toFetch.length === 0) {
		// Nothing new — still persist any change to the overflow queue + poll timestamp.
		const cursor: EmailPollCursor = { ...existing, pending };
		return { events: [], stateUpdate: { cursor, lastPolledAt: now } };
	}

	// Fetch each selected message. A transient per-message error (429/5xx) must NOT discard the
	// whole batch: stop, requeue the errored id + everything unreached to the FRONT of pending,
	// and commit what we already fetched. Only a poll with ZERO successful fetches rethrows, so
	// systemic failures (API down, expired credential) still reach the auto-disable counter.
	const events: NormalizedAppEvent[] = [];
	for (let i = 0; i < toFetch.length; i++) {
		const id = toFetch[i];
		try {
			const event = await adapter.fetchAndNormalize(ctx, id);
			if (event) events.push(event);
		} catch (err) {
			if (events.length === 0) throw err; // no progress this poll → surface for auto-disable
			logger.warn(
				{ err, messageId: id },
				'[app-trigger] email fetch failed mid-batch — committing progress, requeuing the rest',
			);
			pending = [...toFetch.slice(i), ...pending]; // errored id + unreached, retried first next poll
			break;
		}
	}

	// A message with no readable timestamp must NOT advance the watermark (that would ratchet it
	// forward and skip unfetched older mail) — treat it as sitting at the existing watermark.
	const tsOf = (event: NormalizedAppEvent): string => event.occurredAt ?? existing.watermark;

	// Advance the watermark to the newest email actually fetched, and recompute the boundary
	// dedup set to the ids sharing that timestamp.
	let watermark = existing.watermark;
	for (const event of events) {
		watermark = laterIso(watermark, tsOf(event));
	}
	// Boundary = every fetched id in the SAME SECOND as the watermark (not the exact ms). The
	// next query re-lists that whole second, so all its ids must be de-duplicated or a
	// same-second sibling of the newest email re-fires on every poll.
	const wmSec = toEpochSec(watermark);
	const boundaryIds = events
		.filter((event) => toEpochSec(tsOf(event)) === wmSec)
		.map((event) => event.id);
	// If the watermark advanced to a new second the old query window (and its seenIds) no longer
	// overlaps, so keep only the new boundary. If it stayed in the same second (e.g. all fetched
	// were drained overflow), union with the prior boundary so dedup coverage isn't lost.
	const seenIds =
		toEpochSec(existing.watermark) !== wmSec
			? boundaryIds
			: [...new Set([...existing.seenIds, ...boundaryIds])];

	const cursor: EmailPollCursor = { watermark, seenIds, pending };
	return { events, stateUpdate: { cursor, lastPolledAt: now } };
}

/**
 * Builds the shared "New email received" event descriptor so every mail provider advertises
 * an identical event id, payload shape, and base params. Extra provider-specific params
 * (a Gmail label picker, an Outlook folder) are appended by the caller.
 */
export function buildEmailReceivedEvent(
	extraParams: AppTriggerParamField[] = [],
): AppTriggerEventInfo {
	return {
		id: 'message.received',
		name: 'New email received',
		description: 'Fires when a new message arrives in the mailbox.',
		params: extraParams,
		payloadShape:
			'{ from, to, subject, snippet, body, receivedAt, messageId, threadId, labels, raw }',
	};
}

/**
 * The provider-agnostic fields each mail service extracts from one message. A provider maps its
 * API object to this, then {@link buildEmailEvent} assembles the single canonical payload — so
 * the shape advertised by {@link buildEmailReceivedEvent}'s `payloadShape` has one source of
 * truth instead of being hand-built in every provider.
 */
export interface EmailEventInput {
	/** Stable per-message id (drives dedup); `messageId` defaults to this. */
	id: string;
	/**
	 * ISO-8601 received time — drives the watermark and is echoed as `payload.receivedAt`.
	 * Leave `undefined` when the message genuinely carries no timestamp; the core then treats it
	 * as sitting at the existing watermark rather than ratcheting the cursor forward. NEVER
	 * substitute `now` — that would skip unfetched older mail.
	 */
	occurredAt?: string;
	from: string;
	to: string;
	subject: string;
	snippet: string;
	body: string;
	threadId?: string;
	labels?: string[];
	/** Original API object, passed through untouched as `payload.raw`. */
	raw: unknown;
	/** Overrides `payload.messageId` when the wire id differs from the dedup id (rare). */
	messageId?: string;
}

/** Assemble the shared normalized email event from provider-extracted fields. */
export function buildEmailEvent(input: EmailEventInput): NormalizedAppEvent {
	return {
		id: input.id,
		occurredAt: input.occurredAt,
		payload: {
			from: input.from,
			to: input.to,
			subject: input.subject,
			snippet: input.snippet,
			body: input.body,
			receivedAt: input.occurredAt,
			messageId: input.messageId ?? input.id,
			threadId: input.threadId,
			labels: input.labels ?? [],
			raw: input.raw,
		},
	};
}

/**
 * Abstract base for a polling email-trigger provider. A concrete mail service supplies its
 * identity, credential types, event params, the adapter, and (optionally) resource listing;
 * everything else — poll mode, cadence floor, the event, and the poll algorithm — is inherited.
 */
export abstract class EmailPollingTriggerProvider implements AppTriggerProvider {
	abstract readonly id: string;
	abstract readonly displayName: string;
	abstract readonly icon?: string;
	abstract readonly compatibleCredentialTypes: string[];
	abstract readonly setupNote?: string;

	readonly deliveryMode = 'poll' as const;
	readonly minPollIntervalSec = MIN_EMAIL_POLL_INTERVAL_SEC;

	/** Provider-specific event parameters appended to the shared "New email received" event. */
	protected abstract eventParams(): AppTriggerParamField[];

	/**
	 * List ids of messages received at-or-after `watermark` (ISO-8601), newest first, using
	 * server-side filtering. The core applies dedup + the fetch budget on top.
	 */
	protected abstract listSince(
		ctx: AppTriggerProviderContext,
		params: Record<string, unknown>,
		watermark: string,
	): Promise<string[]>;

	/**
	 * Fetch one message by id and map it to the shared normalized email payload (via
	 * {@link buildEmailEvent}). `occurredAt` MUST be the received time — it drives the watermark.
	 * Returns null if the message vanished between listing and fetching.
	 */
	protected abstract fetchAndNormalize(
		ctx: AppTriggerProviderContext,
		id: string,
	): Promise<NormalizedAppEvent | null>;

	listEvents(): AppTriggerEventInfo[] {
		return [buildEmailReceivedEvent(this.eventParams())];
	}

	async poll(
		ctx: AppTriggerProviderContext,
		_eventId: string,
		params: Record<string, unknown>,
		state: AppTriggerState,
	): Promise<AppTriggerPollResult> {
		const adapter: EmailPollAdapter = {
			listSince: (c, p, w) => this.listSince(c, p, w),
			fetchAndNormalize: (c, id) => this.fetchAndNormalize(c, id),
		};
		return runEmailPoll(adapter, ctx, params, state);
	}

	/** Providers with dynamic dropdowns (e.g. a Gmail label picker) override this. */
	listResources?(
		ctx: AppTriggerProviderContext,
		resourceType: string,
		query: { search?: string; cursor?: string },
	): Promise<AppTriggerResourceListResult>;
}
