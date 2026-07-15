import type {
	AppTriggerEventInfo,
	AppTriggerProviderInfo,
	AppTriggerResourceOption,
	AppTriggerState,
	ExecuteRequestOptions,
} from '@repo/types';

/**
 * App-trigger provider contract — the open protocol for "run a workflow when an
 * external app emits an event". Modeled on the knowledge CloudStorageProvider
 * pattern: each app is one self-contained implementation, registered once in
 * AppTriggerProviderRegistry. Adding an app = one class + one registry entry.
 *
 * A provider declares exactly one `deliveryMode` and implements the matching
 * method(s):
 *   - 'poll'    → poll()                                   (Gmail, Outlook, Google Forms)
 *   - 'webhook' → registerWebhook/renewWebhook/unregisterWebhook + handleWebhook
 *                                                          (Notion, Slack)
 *   - 'stream'  → startListening()                         (no v1 provider yet)
 *
 * Uniform data flow: every listening method receives the trigger's current
 * persisted `state` (AppTriggerState, {} on first run) and returns the events to
 * fire PLUS an optional `stateUpdate` the manager merges + persists. The manager
 * owns all persistence; providers stay stateless and testable.
 *
 * All outbound HTTP goes through the credential-bound `ctx.execute()` so OAuth2
 * refresh (proactive + reactive 401) is handled uniformly. Providers own ALL
 * outbound URLs and must validate any user-supplied id (SSRF guard).
 */

/** Per-call context handed to a provider — bound to one credential. */
export interface AppTriggerProviderContext {
	credentialId: string;
	ownerId: string;
	/** Execute an authenticated HTTP request using this credential (OAuth refresh handled). */
	execute(request: ExecuteRequestOptions): Promise<Response>;
	/**
	 * Decrypted credential data — for secrets used OUTSIDE the credential's own auth
	 * (e.g. Slack signing secret / manifest config token, Notion verification token).
	 */
	loadCredentialData(): Promise<Record<string, unknown>>;
	/** Persist updated credential data (e.g. a rotated Slack config token). */
	saveCredentialData(data: Record<string, unknown>): Promise<void>;
}

/** What every event collapses into before it enters the trigger funnel. */
export interface NormalizedAppEvent {
	/** Stable per-event id for dedup (e.g. gmail messageId, notion pageId+editTime). */
	id: string;
	/** ISO timestamp the event occurred, if known. */
	occurredAt?: string;
	/**
	 * Normalized, documented fields PLUS a `raw` field carrying the original API
	 * object — handed to the workflow via {{trigger.payload}}.
	 */
	payload: Record<string, unknown>;
}

/** Result of subscribing with the external app's API — drives renewal/teardown. */
export interface AppWebhookRegistration {
	/** Watch id / subscription id / manifest marker — persisted to trigger.state */
	subscriptionId?: string;
	/** When the subscription must be renewed (ISO), e.g. Gmail watch ≤ 7 days */
	expiresAt?: string;
	/**
	 * Whether the subscription was actually created via the app's API ('auto') or the
	 * provider only prepared internal state and the user must add the delivery URL in the
	 * app themselves ('manual', e.g. Notion always, Slack without a config token).
	 * Omitted ⇒ treated as 'auto'.
	 */
	mode?: 'auto' | 'manual';
	/**
	 * Provider-specific extras merged into trigger.state (e.g. Gmail baseline
	 * historyId / cursor). Merged at the top level of AppTriggerState.
	 */
	extra?: Partial<AppTriggerState>;
}

/** Raw inbound webhook delivery passed to a provider for verify + parse. */
export interface AppWebhookRequest {
	rawBody: Buffer;
	headers: Record<string, string>;
	query: Record<string, string>;
}

/** Outcome of handling an inbound webhook delivery. */
export interface AppWebhookHandleResult {
	/** False ⇒ the route returns a generic 401 (verification failed). */
	ok: boolean;
	/** Events to fire into the funnel (one workflow run each). */
	events: NormalizedAppEvent[];
	/**
	 * Optional synchronous HTTP response to send instead of the default 202
	 * (e.g. Slack/Notion url-verification challenge, Pub/Sub ack).
	 */
	response?: { status: number; body?: unknown };
	/** State patch to merge + persist (e.g. captured verification token, advanced cursor). */
	stateUpdate?: Partial<AppTriggerState>;
}

/** Result of a poll cycle. */
export interface AppTriggerPollResult {
	events: NormalizedAppEvent[];
	/** State patch to merge + persist for the next cycle (typically { cursor }). */
	stateUpdate?: Partial<AppTriggerState>;
}

/** One page of selectable resources for a `type: 'resource'` param field. */
export interface AppTriggerResourceListResult {
	options: AppTriggerResourceOption[];
	/** Opaque cursor for the next page; absent ⇒ no more results. */
	nextCursor?: string;
}

export interface AppTriggerProvider {
	readonly id: string;
	readonly displayName: string;
	/** Static logo path served by the web app (e.g. '/logos/gmail.svg') */
	readonly icon?: string;
	/** Credential definition ids this provider accepts */
	readonly compatibleCredentialTypes: string[];
	readonly deliveryMode: 'poll' | 'webhook' | 'stream';
	/** Minimum poll interval in seconds (poll providers) — the manager clamps to this. */
	readonly minPollIntervalSec?: number;
	/** One-time setup guidance surfaced in the builder. */
	readonly setupNote?: string;

	/** Events this provider can trigger on (drives the builder UI + param schemas). */
	listEvents(): AppTriggerEventInfo[];

	// ── poll mode ──
	/**
	 * state.cursor undefined ⇒ first run: the provider MUST return events:[] and a
	 * baseline cursor so historical items are not replayed on activation.
	 */
	poll?(
		ctx: AppTriggerProviderContext,
		eventId: string,
		params: Record<string, unknown>,
		state: AppTriggerState,
	): Promise<AppTriggerPollResult>;

	// ── webhook mode ──
	registerWebhook?(
		ctx: AppTriggerProviderContext,
		eventId: string,
		params: Record<string, unknown>,
		deliveryUrl: string,
		state: AppTriggerState,
	): Promise<AppWebhookRegistration>;
	renewWebhook?(
		ctx: AppTriggerProviderContext,
		eventId: string,
		params: Record<string, unknown>,
		deliveryUrl: string,
		state: AppTriggerState,
	): Promise<AppWebhookRegistration>;
	unregisterWebhook?(
		ctx: AppTriggerProviderContext,
		eventId: string,
		params: Record<string, unknown>,
		state: AppTriggerState,
	): Promise<void>;
	handleWebhook?(
		ctx: AppTriggerProviderContext,
		eventId: string,
		params: Record<string, unknown>,
		state: AppTriggerState,
		req: AppWebhookRequest,
	): Promise<AppWebhookHandleResult>;

	// ── stream mode ──
	startListening?(
		ctx: AppTriggerProviderContext,
		eventId: string,
		params: Record<string, unknown>,
		emit: (event: NormalizedAppEvent) => void,
	): Promise<{ stop: () => Promise<void> }>;

	// ── test/seed sampling (drives the workflow builder's "Fetch latest" test flow) ──
	/**
	 * Fetch the single most recent real event, for seeding a workflow Test run. MUST be
	 * side-effect-free — it does NOT advance the live poll cursor / write any state (unlike
	 * `poll()`, which baselines + persists a cursor). Returns null when the source is empty.
	 * Left undefined by inbound-only providers (Notion, Slack) — the test flow then falls
	 * back to a user-pasted JSON payload.
	 */
	fetchLatestEvent?(
		ctx: AppTriggerProviderContext,
		eventId: string,
		params: Record<string, unknown>,
	): Promise<NormalizedAppEvent | null>;

	// ── dynamic resource listing (drives `type: 'resource'` dropdowns) ──
	/**
	 * List selectable resources for a `type: 'resource'` param field, using the
	 * credential-bound ctx. `resourceType` matches AppTriggerParamField.resource.type;
	 * `query.search` is the user's filter and `query.cursor` pages results. Providers
	 * MUST own the URL (SSRF guard) and use ctx.execute for authenticated calls.
	 * An unknown resourceType should return `{ options: [] }`.
	 */
	listResources?(
		ctx: AppTriggerProviderContext,
		resourceType: string,
		query: { search?: string; cursor?: string },
	): Promise<AppTriggerResourceListResult>;
}

/** Maps a provider to its wire catalog representation (for GET /v1/app-triggers/providers). */
export function toProviderInfo(provider: AppTriggerProvider): AppTriggerProviderInfo {
	return {
		id: provider.id,
		displayName: provider.displayName,
		icon: provider.icon,
		deliveryMode: provider.deliveryMode,
		compatibleCredentialTypes: provider.compatibleCredentialTypes,
		events: provider.listEvents(),
		setupNote: provider.setupNote,
	};
}

/** Returns the provider's event definition by id, or undefined. */
export function findEvent(
	provider: AppTriggerProvider,
	eventId: string,
): AppTriggerEventInfo | undefined {
	return provider.listEvents().find((event) => event.id === eventId);
}

/** Reads a capped error-body excerpt for provider error messages. */
export async function readErrorExcerpt(response: Response): Promise<string> {
	const MAX_ERROR_BODY_CHARS = 300;
	try {
		const text = await response.text();
		return text.slice(0, MAX_ERROR_BODY_CHARS);
	} catch {
		return '';
	}
}

/**
 * Coerce a freeform param value (scalar, array, or undefined) into a clean string[]
 * of trimmed, non-empty ids. Lets a provider read a param uniformly whether it was
 * stored as a single value or a multi-select array (see `resource.multiple`).
 */
export function toStringArray(value: unknown): string[] {
	const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
	return items
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}
