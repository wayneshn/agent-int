import { SignJWT } from 'jose';
import { TEST_JWT_SECRET, TEST_PROXY_TOKEN_SECRET } from './env.js';

/**
 * Token minting for tests. Mirrors the issuers:
 *   - user JWTs: apps/backend/src/services/AuthService.ts (#generateAccessToken)
 *   - sandbox proxy tokens: apps/backend/src/services/AgentProxyService.ts
 * Both are HS256 over the fixed test secrets from env.ts.
 */

export interface ProxyTokenClaims {
	agentId: string;
	ownerId: string;
	threadId: string;
	/** Credential allowlist snapshot (matches AgentProxyService.tokenClaims). */
	credentialIds?: string[];
	allCredentials?: boolean;
	missionId?: string;
}

/** Mint a sandbox access PROXY_TOKEN (type: 'access'), as issueProxyToken does. */
export async function mintProxyToken(claims: ProxyTokenClaims, expiresIn = '15m'): Promise<string> {
	return new SignJWT({
		agentId: claims.agentId,
		ownerId: claims.ownerId,
		threadId: claims.threadId,
		credentialIds: claims.credentialIds ?? [],
		allCredentials: claims.allCredentials,
		missionId: claims.missionId,
		type: 'access',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime(expiresIn)
		.sign(new TextEncoder().encode(TEST_PROXY_TOKEN_SECRET));
}

/** Mint a sandbox refresh token (type: 'refresh') — must be rejected on /internal/*. */
export async function mintProxyRefreshToken(
	claims: ProxyTokenClaims,
	expiresIn = '8h',
): Promise<string> {
	return new SignJWT({
		agentId: claims.agentId,
		ownerId: claims.ownerId,
		threadId: claims.threadId,
		credentialIds: claims.credentialIds ?? [],
		allCredentials: claims.allCredentials,
		missionId: claims.missionId,
		type: 'refresh',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime(expiresIn)
		.sign(new TextEncoder().encode(TEST_PROXY_TOKEN_SECRET));
}

export interface UserJwtClaims {
	sub: string;
	email?: string;
	roles?: string[];
}

/** Mint a user session JWT, as AuthService.#generateAccessToken does. */
export async function mintUserJwt(claims: UserJwtClaims, expiresIn = '1h'): Promise<string> {
	return new SignJWT({
		email: claims.email,
		roles: claims.roles ?? [],
	} as Record<string, unknown>)
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setSubject(claims.sub)
		.setExpirationTime(expiresIn)
		.sign(new TextEncoder().encode(TEST_JWT_SECRET));
}
