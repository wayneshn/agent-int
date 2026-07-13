import { createSign } from 'node:crypto';
import type { CredentialDefinition, ResolvedCredential, ExecuteRequestOptions } from '@repo/types';
import { getCredentialDefinition } from '@repo/utils';
import { CredentialService } from './CredentialService.js';

// Re-export so callers can import these types from this module if needed
export type { ResolvedCredential, ExecuteRequestOptions };

/**
 * executeWithCredential options with a body widened to also accept Blob / FormData
 * (binary and multipart uploads). The shared ExecuteRequestOptions keeps body as a
 * string so @repo/types stays free of DOM/Node globals; the backend broadens it here.
 * A plain string body (ExecuteRequestOptions) is assignable to this, so existing
 * callers are unaffected.
 */
export interface ExecuteWithCredentialOptions extends Omit<ExecuteRequestOptions, 'body'> {
	body?: string | Blob | FormData;
}

/** Token refresh threshold — refresh proactively if token expires within this many ms */
const REFRESH_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Service responsible for resolving credential data into HTTP request
 * components (headers, query params, body) based on the YAML definitions.
 *
 * Two public methods:
 *   - resolve()                 — returns resolved headers/qs/body (declarative use)
 *   - executeWithCredential()   — owns the full HTTP request + reactive 401 refresh
 */
export class CredentialResolverService {
	private credentialService: CredentialService;

	constructor(credentialService: CredentialService) {
		this.credentialService = credentialService;
	}

	/**
	 * Resolves a credential into ready-to-use HTTP request components.
	 * For OAuth2 credentials, triggers proactive token refresh only when
	 * expiresAt is known and the token is approaching expiry.
	 */
	async resolve(credentialId: string, ownerId: string): Promise<ResolvedCredential> {
		const { data, definition } = await this.loadCredentialContext(credentialId, ownerId);

		let currentData = data;

		// Proactive refresh — only when we know the token's expiry time
		if (definition.type === 'oauth2' && this.isTokenExpiringSoon(currentData)) {
			currentData = await this.refreshAndSave(credentialId, ownerId, currentData, definition);
		}

		return this.applyRequestMapping(currentData, definition);
	}

	/**
	 * Executes an HTTP request using the resolved credential, with reactive
	 * 401-triggered token refresh for OAuth2 credentials.
	 *
	 * Flow:
	 *   1. Proactively refresh if expiresAt is known and approaching
	 *   2. Merge caller-provided qs + credential-resolved qs into the URL
	 *   3. Make the first request
	 *   4. On 401 (for oauth2): refresh token once, then retry
	 *   5. Return the final response regardless of status
	 */
	async executeWithCredential(
		credentialId: string,
		ownerId: string,
		request: ExecuteWithCredentialOptions,
	): Promise<Response> {
		const { data, definition } = await this.loadCredentialContext(credentialId, ownerId);

		let currentData = data;

		// Proactive refresh only when we have expiry info
		if (definition.type === 'oauth2' && this.isTokenExpiringSoon(currentData)) {
			currentData = await this.refreshAndSave(credentialId, ownerId, currentData, definition);
		}

		const resolved = this.applyRequestMapping(currentData, definition);
		// const resolved = await this.resolve(credentialId, ownerId)

		const url = this.buildUrl(request.url, request.qs, resolved.qs);
		const mergedHeaders = { ...request.headers, ...resolved.headers };

		const firstResponse = await fetch(url, {
			method: request.method,
			headers: mergedHeaders,
			body: request.body,
		});

		// Reactive refresh — retry once on 401 for OAuth2 credentials
		if (firstResponse.status === 401 && definition.type === 'oauth2') {
			const refreshed = await this.refreshAndSave(credentialId, ownerId, currentData, definition);
			const retriedResolved = this.applyRequestMapping(refreshed, definition);
			const retriedUrl = this.buildUrl(request.url, request.qs, retriedResolved.qs);
			const retriedHeaders = { ...request.headers, ...retriedResolved.headers };
			return fetch(retriedUrl, {
				method: request.method,
				headers: retriedHeaders,
				body: request.body,
			});
		}

		// Strong Customer Authentication — retry once on 403 with an RSA signature.
		// Some APIs (e.g. Wise) return 403 + a one-time challenge token in a header;
		// we sign that token with the stored private key and resend.
		if (firstResponse.status === 403 && definition.sca) {
			const retried = this.retryWithSca(firstResponse, url, request, mergedHeaders, currentData, definition.sca);
			if (retried) return retried;
		}

		return firstResponse;
	}

	/**
	 * Perform the SCA signed retry: read the one-time challenge token from the 403
	 * response header, RSA-sign it with the credential's stored private key, and
	 * resend the request with the challenge + signature headers added.
	 *
	 * Returns the retried Response, or null when the challenge header or private key
	 * is missing — in which case the original 403 is surfaced to the caller (whose
	 * error body tells the user to add a key pair).
	 */
	private retryWithSca(
		firstResponse: Response,
		url: string,
		request: ExecuteWithCredentialOptions,
		mergedHeaders: Record<string, string>,
		data: Record<string, unknown>,
		sca: NonNullable<CredentialDefinition['sca']>,
	): Promise<Response> | null {
		const approvalHeader = sca.approvalHeader ?? 'x-2fa-approval';
		const signatureHeader = sca.signatureHeader ?? 'x-signature';
		const token = firstResponse.headers.get(approvalHeader);
		const privateKey = data[sca.privateKeyProperty];
		if (!token || typeof privateKey !== 'string' || privateKey.length === 0) {
			return null;
		}

		const signer = createSign(sca.algorithm ?? 'RSA-SHA256');
		signer.update(token);
		signer.end();
		const signature = signer.sign(privateKey, 'base64');

		return fetch(url, {
			method: request.method,
			headers: {
				...mergedHeaders,
				[approvalHeader]: token,
				[signatureHeader]: signature,
			},
			body: request.body,
		});
	}

	/**
	 * Builds the final URL by appending caller-provided qs and credential-resolved qs.
	 * Credential-resolved params take precedence over caller-provided params for
	 * any overlapping keys (e.g. an API token param in the YAML wins over an
	 * accidental duplicate from the caller).
	 */
	private buildUrl(
		baseUrl: string,
		callerQs: Record<string, string> | undefined,
		credentialQs: Record<string, string>,
	): string {
		const merged = { ...(callerQs ?? {}), ...credentialQs };
		if (Object.keys(merged).length === 0) return baseUrl;

		const url = new URL(baseUrl);
		for (const [key, value] of Object.entries(merged)) {
			url.searchParams.set(key, value);
		}
		return url.toString();
	}

	/**
	 * Returns true only when we have an expiresAt value and the token is within
	 * the refresh threshold window. Avoids unnecessary refreshes when the provider
	 * does not return expires_in.
	 */
	private isTokenExpiringSoon(data: Record<string, unknown>): boolean {
		const expiresAt = data.expiresAt as number | undefined;
		return expiresAt !== undefined && Date.now() >= expiresAt - REFRESH_THRESHOLD_MS;
	}

	/**
	 * Loads credential metadata + definition + decrypted data in one shot.
	 * Throws descriptive errors if anything is missing.
	 */
	private async loadCredentialContext(
		credentialId: string,
		ownerId: string,
	): Promise<{ data: Record<string, unknown>; definition: CredentialDefinition }> {
		const metadata = await this.credentialService.getById(credentialId, ownerId);
		if (!metadata) {
			throw new Error(`Credential not found: ${credentialId}`);
		}

		const definition = getCredentialDefinition(metadata.type);
		if (!definition) {
			throw new Error(`No credential definition found for type: ${metadata.type}`);
		}

		const data = await this.credentialService.getDecryptedData(credentialId, ownerId);
		if (!data) {
			throw new Error(`Failed to decrypt credential data for: ${credentialId}`);
		}

		return { data, definition };
	}

	/**
	 * Refreshes the OAuth2 access token and persists the new tokens.
	 * Returns the updated data object with the new tokens merged in.
	 */
	private async refreshAndSave(
		credentialId: string,
		ownerId: string,
		data: Record<string, unknown>,
		definition: CredentialDefinition,
	): Promise<Record<string, unknown>> {
		const refreshed = await this.refreshOAuth2Token(data, definition);
		await this.credentialService.updateData(credentialId, ownerId, refreshed);
		return refreshed;
	}

	/**
	 * Performs the OAuth2 token refresh/re-fetch.
	 * - client_credentials: re-fetches a new token directly (no refresh_token needed)
	 * - authorizationCode: uses the stored refresh_token
	 */
	private async refreshOAuth2Token(
		data: Record<string, unknown>,
		definition: CredentialDefinition,
	): Promise<Record<string, unknown>> {
		const oauth2Config = definition.oauth2;
		if (!oauth2Config) {
			throw new Error(`OAuth2 config missing for definition: ${definition.id}`);
		}

		const clientIdKey = oauth2Config.clientIdProperty ?? 'clientId';
		const clientSecretKey = oauth2Config.clientSecretProperty ?? 'clientSecret';
		const clientId = data[clientIdKey] as string;
		const clientSecret = data[clientSecretKey] as string;

		const grantType = oauth2Config.grantType ?? 'authorizationCode';

		let body: URLSearchParams;

		if (grantType === 'clientCredentials') {
			// Re-fetch a token using client credentials — no refresh_token involved
			body = new URLSearchParams({
				grant_type: 'client_credentials',
				client_id: clientId,
				client_secret: clientSecret,
			});
			if (oauth2Config.scope) {
				body.set('scope', oauth2Config.scope);
			}
		} else {
			// Authorization code grant — use the stored refresh_token
			const refreshToken = data.refreshToken as string | undefined;
			if (!refreshToken) {
				throw new Error(`No refresh token available for credential type: ${definition.id}`);
			}
			body = new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: clientId,
				client_secret: clientSecret,
			});
		}

		const headers: Record<string, string> = {
			'Content-Type': 'application/x-www-form-urlencoded',
		};

		// If authStyle is inHeader, send client credentials as Basic auth instead of body
		if (oauth2Config.authStyle === 'inHeader') {
			const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
			headers['Authorization'] = `Basic ${encoded}`;
		}

		const response = await fetch(oauth2Config.accessTokenUrl, {
			method: 'POST',
			headers,
			body: body.toString(),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(`OAuth2 token refresh failed (${response.status}): ${errorBody}`);
		}

		const tokenResponse = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in?: number;
		};

		return {
			...data,
			accessToken: tokenResponse.access_token,
			// Preserve the existing refresh_token when the provider does not rotate it
			refreshToken: tokenResponse.refresh_token ?? data.refreshToken,
			expiresAt: tokenResponse.expires_in
				? Date.now() + tokenResponse.expires_in * 1000
				: undefined,
		};
	}

	/**
	 * Applies the YAML requestMapping template to produce final HTTP components.
	 * Replaces {{properties.keyName}} placeholders with actual decrypted values.
	 *
	 * Special handling for basicAuth: if type is 'basicAuth' and no explicit
	 * requestMapping is defined, auto-injects a standard Basic auth header
	 * from the credential's `username` and `password` properties.
	 */
	private applyRequestMapping(
		data: Record<string, unknown>,
		definition: CredentialDefinition,
	): ResolvedCredential {
		// Auto-inject Basic auth header when no explicit requestMapping is provided
		if (definition.type === 'basicAuth' && !definition.requestMapping) {
			const username = (data.username as string) ?? '';
			const password = (data.password as string) ?? '';
			const encoded = Buffer.from(`${username}:${password}`).toString('base64');
			return {
				headers: { Authorization: `Basic ${encoded}` },
				qs: {},
				body: {},
			};
		}

		const mapping = definition.requestMapping;
		if (!mapping) {
			return { headers: {}, qs: {}, body: {} };
		}

		return {
			headers: this.interpolateRecord(mapping.headers ?? {}, data),
			qs: this.interpolateRecord(mapping.qs ?? {}, data),
			body: this.interpolateRecord(mapping.body ?? {}, data),
		};
	}

	/**
	 * Interpolates {{properties.keyName}} placeholders in both keys and values
	 * of a Record. Key interpolation is needed for dynamic header names
	 * (e.g. httpHeaderAuth where the header name itself is user-configured).
	 */
	private interpolateRecord(
		record: Record<string, string>,
		data: Record<string, unknown>,
	): Record<string, string> {
		const result: Record<string, string> = {};
		for (const [key, template] of Object.entries(record)) {
			const resolvedKey = this.interpolateTemplate(key, data);
			result[resolvedKey] = this.interpolateTemplate(template, data);
		}
		return result;
	}

	/**
	 * Replaces all {{properties.keyName}} occurrences in a template string.
	 */
	interpolateTemplate(template: string, data: Record<string, unknown>): string {
		return template.replace(/\{\{properties\.(\w+)\}\}/g, (_match, propertyName: string) => {
			const value = data[propertyName];
			return value !== undefined ? String(value) : '';
		});
	}
}
