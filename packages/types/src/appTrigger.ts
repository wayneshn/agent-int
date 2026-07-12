import type { ApiResponse } from './api.js';
import type { AppTriggerRegistrationStatus } from './agentRuntime.js';

/**
 * App-trigger catalog types.
 *
 * These describe the data-driven catalog of app-trigger providers (Gmail, Notion,
 * Slack, Google Forms, …) surfaced to the workflow builder so the UI can render a
 * provider → credential → event → params picker without knowing any provider internals.
 *
 * The backend AppTriggerProvider implementations are the source of truth; the catalog
 * route (`GET /v1/app-triggers/providers`) maps them to these wire types.
 */

/** How a provider listens for events. */
export type AppTriggerDeliveryMode = 'poll' | 'webhook' | 'stream';

/**
 * Field control type.
 * - 'select'   — static dropdown whose choices come from `options`.
 * - 'resource' — dynamic, server-fetched, searchable dropdown driven by `resource`
 *   (e.g. a Notion database, a Slack channel, a Gmail label). The builder calls
 *   `GET /v1/app-triggers/:providerId/resources` with the selected credential.
 */
export type AppTriggerParamType = 'string' | 'number' | 'boolean' | 'select' | 'resource';

/** Declares the dynamic-listing contract for a `type: 'resource'` field. */
export interface AppTriggerResourceDescriptor {
	/** Provider-defined resource kind, e.g. 'gmail-label', 'notion-database', 'slack-channel'. */
	type: string;
	/** Allow selecting multiple values → params[name] is a string[]. Default false (scalar string). */
	multiple?: boolean;
	/** Show the debounced server-side search box. Default true. */
	searchable?: boolean;
}

/** A single user-configurable parameter for an event (drives a form field in the builder). */
export interface AppTriggerParamField {
	/**
	 * Machine name, stored under AppTriggerConfig.params[name]. For a `resource` field the
	 * stored value is a scalar string (single) or a string[] (when `resource.multiple`).
	 */
	name: string;
	/** Human label shown next to the field */
	label: string;
	/** Field control type */
	type: AppTriggerParamType;
	/** Whether the field must be provided */
	required?: boolean;
	/** Helper text shown under the field */
	description?: string;
	/** Placeholder text for string/number inputs */
	placeholder?: string;
	/** Options for static `select` fields */
	options?: { label: string; value: string }[];
	/** Present iff `type === 'resource'` — describes the dynamic dropdown. */
	resource?: AppTriggerResourceDescriptor;
	/** Default value applied when the user leaves the field untouched */
	default?: string | number | boolean;
}

/** A single selectable resource returned by a provider's listResources. */
export interface AppTriggerResourceOption {
	/** The id stored in params (e.g. a channel id, database id, label id). */
	value: string;
	/** Human label shown in the dropdown (e.g. '#general', a database title). */
	label: string;
	/** Optional secondary text. */
	description?: string;
	/** Optional icon URL. */
	icon?: string;
}

/** One page of resource options. */
export interface AppTriggerResourcesPage {
	options: AppTriggerResourceOption[];
	/** Opaque cursor for the next page; absent ⇒ no more results. */
	nextCursor?: string;
}

/** One event a provider can trigger on. */
export interface AppTriggerEventInfo {
	/** Event id, e.g. 'message.received', 'database.itemChanged' */
	id: string;
	/** Human label, e.g. "New email received" */
	name: string;
	/** Short description of when this fires */
	description: string;
	/** Parameters the user configures for this event */
	params: AppTriggerParamField[];
	/**
	 * Human-readable description of the normalized payload shape handed to the
	 * workflow via {{trigger.payload}} (for builder documentation).
	 */
	payloadShape?: string;
}

/** A provider in the catalog. */
export interface AppTriggerProviderInfo {
	/** Provider id, e.g. 'gmail' */
	id: string;
	/** Display name, e.g. "Gmail" */
	displayName: string;
	/** Static logo path served by the web app (e.g. '/logos/gmail.svg') */
	icon?: string;
	/** How this provider listens */
	deliveryMode: AppTriggerDeliveryMode;
	/** Credential definition ids this provider accepts (for the credential picker) */
	compatibleCredentialTypes: string[];
	/** Events the provider can trigger on */
	events: AppTriggerEventInfo[];
	/**
	 * Optional one-time setup guidance shown in the builder (e.g. required scopes for a
	 * polling provider, manifest config token for Slack).
	 */
	setupNote?: string;
}

// ─── API Response Envelopes ───────────────────────────────────────────────────

export type AppTriggerProvidersResponse = ApiResponse<AppTriggerProviderInfo[]>;

export type AppTriggerResourcesResponse = ApiResponse<AppTriggerResourcesPage>;

export type AppTriggerRegistrationResponse = ApiResponse<AppTriggerRegistrationStatus>;
