/** Core authentication strategies supported by the credential system */
export type CredentialType =
	| 'apiKey'
	| 'basicAuth'
	| 'bearerToken'
	| 'oauth2'
	| 'oauth1'
	| 'custom';

/** Data types for credential property inputs */
export type PropertyType = 'string' | 'secret' | 'number' | 'boolean' | 'options';

/** Dropdown option for properties with type === 'options' */
export interface CredentialPropertyOption {
	name: string;
	value: string | number;
}

/** A single input field definition for a credential form */
export interface CredentialProperty {
	name: string;
	displayName: string;
	type: PropertyType;
	required: boolean;
	default?: string | number | boolean;
	description?: string;
	options?: CredentialPropertyOption[];
}

/** OAuth2-specific configuration block */
export interface OAuth2Config {
	authorizationUrl: string;
	accessTokenUrl: string;
	revokeUrl?: string;
	clientIdProperty?: string;
	clientSecretProperty?: string;
	scope?: string;
	authStyle?: 'inHeader' | 'inBody';
	/**
	 * OAuth2 grant type to use.
	 * - `authorizationCode` (default): standard 3-legged flow with browser redirect
	 * - `clientCredentials`: machine-to-machine, no user redirect needed
	 */
	grantType?: 'authorizationCode' | 'clientCredentials';
	/**
	 * When true, uses PKCE (S256 code challenge) in the authorization code flow.
	 * Recommended for public clients. Replaces client_secret in the token exchange.
	 */
	usePkce?: boolean;
	/**
	 * Additional query parameters appended to the authorization URL.
	 * Use this for provider-specific params (e.g. Google's access_type=offline,
	 * prompt=consent) that must not be sent to every provider.
	 */
	extraAuthParams?: Record<string, string>;
}

/**
 * Strong Customer Authentication config — enables a signed 403-challenge retry.
 * Some APIs (e.g. Wise) protect endpoints by returning 403 with a one-time
 * challenge token in a response header; the client must RSA-sign that token and
 * resend the request with the signature. When present and the credential has a
 * stored private key, the resolver performs this signed retry automatically.
 */
export interface ScaConfig {
	/** Name of the (secret) property holding the PEM-encoded RSA private key. */
	privateKeyProperty: string;
	/** Response header carrying the challenge token on a 403. Default 'x-2fa-approval'. */
	approvalHeader?: string;
	/** Request header the signature is sent in on retry. Default 'x-signature'. */
	signatureHeader?: string;
	/** Node crypto signing algorithm. Default 'RSA-SHA256'. */
	algorithm?: string;
}

/** HTTP request mapping — tells the engine where to inject credentials */
export interface RequestMapping {
	headers?: Record<string, string>;
	qs?: Record<string, string>;
	body?: Record<string, string>;
}

/** Test request definition — used to validate a credential and optionally fetch account identity */
export interface TestRequest {
	method: 'GET' | 'POST';
	url: string;
	/**
	 * Optional HTTP headers to include with the test request.
	 * Use this for APIs that require a specific Content-Type or other headers
	 * that are not injected by the credential's requestMapping.
	 * Example: { 'Content-Type': 'application/json' }
	 */
	headers?: Record<string, string>;
	/**
	 * Optional request body string sent with POST test requests.
	 * Required for APIs that are POST-only, such as GraphQL endpoints.
	 * Example: '{"query":"{ account { id email } }"}'
	 */
	body?: string;
	/**
	 * Dot-notation key path into the JSON response body whose value is stored as
	 * `connectedAccount` on the credential after a successful OAuth2 authorization.
	 * Example: "email"  →  response.email
	 *          "data.user.login"  →  response.data.user.login
	 */
	accountIdentifierKey?: string;
}

/**
 * Shape of a credential record without the encrypted data payload.
 * Shared between the backend service and API response types.
 *
 * `isAuthorized` is true for OAuth2 credentials when an access token has been
 * obtained (i.e. the user completed the authorization flow).
 *
 * `connectedAccount` holds a human-readable identifier for the authenticated
 * account (e.g. email, username). For OAuth2 it is populated at authorization
 * time; for other auth types (apiKey, bearerToken, etc.) it is populated when
 * the credential is successfully tested and the definition has an
 * `accountIdentifierKey` in its testRequest.
 */
export interface CredentialMetadata {
	id: string;
	ownerId: string;
	name: string;
	type: string;
	createdAt: Date;
	updatedAt: Date;
	/** OAuth2 only — true when an access token is present */
	isAuthorized?: boolean;
	/** Human-readable account identifier stored after a successful test or OAuth2 authorization */
	connectedAccount?: string;
}

/** Full credential definition loaded from a YAML file */
export interface CredentialDefinition {
	id: string;
	name: string;
	/**
	 * The brand/company name for display purposes (e.g. "GitHub", "Notion").
	 * Falls back to `name` when not set.
	 */
	brandName: string;
	type: CredentialType;
	/** Path or URL to the service logo/icon for the UI */
	icon?: string;
	description?: string;
	documentationUrl?: string;
	properties: CredentialProperty[];
	requestMapping?: RequestMapping;
	oauth2?: OAuth2Config;
	/** Strong Customer Authentication — signed 403-challenge retry (e.g. Wise). */
	sca?: ScaConfig;
	testRequest?: TestRequest;
}

// ─── Resolver / Execution Types ───────────────────────────────────────────────

/**
 * The resolved authentication context produced by CredentialResolverService.
 * Ready to inject into an outbound HTTP request.
 */
export interface ResolvedCredential {
	headers: Record<string, string>;
	/** Query string parameters to append to the request URL */
	qs: Record<string, string>;
	body: Record<string, string>;
}

/**
 * Options for CredentialResolverService.executeWithCredential().
 * Caller-provided qs and headers are merged with credential-resolved values,
 * with credential values taking precedence for auth-specific keys.
 */
export interface ExecuteRequestOptions {
	url: string;
	method: string;
	/** Additional headers to send alongside the credential-injected ones */
	headers?: Record<string, string>;
	/** Additional query string params to append to the URL */
	qs?: Record<string, string>;
	/**
	 * Request body. Typed as string here (this shared type stays DOM/Node-global-free
	 * so browser-safe packages can consume it). The backend widens it to also accept
	 * Blob / FormData for binary and multipart uploads — see CredentialResolverService.
	 */
	body?: string;
}

// ─── Request Bodies ───────────────────────────────────────────────────────────

/**
 * POST /v1/credentials — create a new credential.
 * Ownership is derived from the authenticated token, never from the body.
 */
export interface CreateCredentialRequestBody {
	name: string;
	type: string;
	data: Record<string, unknown>;
}

/** PUT /v1/credentials/:id — update an existing credential */
export interface UpdateCredentialRequestBody {
	name?: string;
	data?: Record<string, unknown>;
}
