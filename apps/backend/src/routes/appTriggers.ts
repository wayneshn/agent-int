import { Router } from 'express';
import type { Request, Response } from 'express';
import type {
	AppTriggerProvidersResponse,
	AppTriggerRegistrationResponse,
	AppTriggerResourcesResponse,
	AppTriggerSampleResponse,
} from '@repo/types';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../config/logger.js';
import type { AuthService } from '../services/AuthService.js';
import type { CredentialResolverService } from '../services/CredentialResolverService.js';
import type { CredentialService } from '../services/CredentialService.js';
import type { AppTriggerManager } from '../services/triggers/AppTriggerManager.js';
import type { AppTriggerProviderRegistry } from '../services/triggers/AppTriggerProviderRegistry.js';
import { toProviderInfo } from '../services/triggers/AppTriggerProvider.js';
import { buildProviderContext } from '../services/triggers/buildProviderContext.js';

/**
 * App-trigger catalog router.
 *
 * Routes (all requireAuth):
 *   GET /v1/app-triggers/providers — the data-driven catalog of providers + events +
 *     param schemas + compatible credential types, used by the workflow builder's
 *     app-trigger picker. Read-only; no per-owner data.
 *   GET /v1/app-triggers/:providerId/resources — dynamic options for a `type: 'resource'`
 *     param field (e.g. Notion databases, Slack channels, Gmail labels), fetched live from
 *     the app's API using the caller's credential. Drives the builder's searchable dropdowns.
 *   POST /v1/app-triggers/:triggerId/register — re-attempt activation/registration for an
 *     existing app trigger and return the fresh status (the builder's "re-check" action).
 */
export function createAppTriggersRouter(
	authService: AuthService,
	registry: AppTriggerProviderRegistry,
	resolver: CredentialResolverService,
	credentialService: CredentialService,
	appTriggerManager: AppTriggerManager,
): Router {
	const router = Router();
	const auth = requireAuth(authService);

	router.get('/providers', auth, (_req: Request, res: Response) => {
		try {
			const providers = registry.getAll().map(toProviderInfo);
			const body: AppTriggerProvidersResponse = { success: true, data: providers };
			res.json(body);
		} catch (err) {
			logger.error({ err }, 'Failed to load app-trigger providers');
			const body: AppTriggerProvidersResponse = {
				success: false,
				error: 'Failed to load app-trigger providers',
			};
			res.status(500).json(body);
		}
	});

	router.get('/:providerId/resources', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { providerId } = req.params as { providerId: string };
		const { resourceType, credentialId, search, cursor } = req.query as {
			resourceType?: string;
			credentialId?: string;
			search?: string;
			cursor?: string;
		};

		const provider = registry.getById(providerId);
		if (!provider) {
			res.status(404).json({ success: false, error: 'Unknown provider' });
			return;
		}
		if (!resourceType || !credentialId) {
			res.status(400).json({
				success: false,
				error: 'resourceType and credentialId are required',
			});
			return;
		}
		if (!provider.listResources) {
			res.status(400).json({
				success: false,
				error: `Provider '${provider.id}' has no listable resources`,
			});
			return;
		}

		const credential = await credentialService.getById(credentialId, ownerId);
		if (!credential) {
			res.status(404).json({ success: false, error: 'Credential not found' });
			return;
		}
		if (!registry.isCompatible(provider, credential.type)) {
			res.status(400).json({
				success: false,
				error: `Credential type '${credential.type}' is not compatible with provider '${provider.id}'.`,
			});
			return;
		}

		try {
			const ctx = buildProviderContext(resolver, credentialService, credentialId, ownerId);
			const result = await provider.listResources(ctx, resourceType, { search, cursor });
			const body: AppTriggerResourcesResponse = { success: true, data: result };
			res.json(body);
		} catch (err) {
			logger.warn({ err, providerId, resourceType }, '[app-trigger] resource listing failed');
			const message = err instanceof Error ? err.message : 'Resource listing failed.';
			const body: AppTriggerResourcesResponse = { success: false, error: message };
			res.status(502).json(body);
		}
	});

	router.post('/:providerId/sample', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { providerId } = req.params as { providerId: string };
		const { credentialId, event, params } = req.body as {
			credentialId?: string;
			event?: string;
			params?: Record<string, unknown>;
		};

		const provider = registry.getById(providerId);
		if (!provider) {
			res.status(404).json({ success: false, error: 'Unknown provider' });
			return;
		}
		if (!credentialId || !event) {
			res.status(400).json({ success: false, error: 'credentialId and event are required' });
			return;
		}
		// Inbound-only providers (Notion, Slack) can't be sampled — the builder falls back to
		// a user-pasted JSON payload. Return a friendly null rather than erroring.
		if (!provider.fetchLatestEvent) {
			const body: AppTriggerSampleResponse = { success: true, data: null };
			res.json(body);
			return;
		}

		const credential = await credentialService.getById(credentialId, ownerId);
		if (!credential) {
			res.status(404).json({ success: false, error: 'Credential not found' });
			return;
		}
		if (!registry.isCompatible(provider, credential.type)) {
			res.status(400).json({
				success: false,
				error: `Credential type '${credential.type}' is not compatible with provider '${provider.id}'.`,
			});
			return;
		}

		try {
			const ctx = buildProviderContext(resolver, credentialService, credentialId, ownerId);
			const eventData = await provider.fetchLatestEvent(ctx, event, params ?? {});
			const body: AppTriggerSampleResponse = {
				success: true,
				data: eventData ? { payload: eventData.payload, occurredAt: eventData.occurredAt } : null,
			};
			res.json(body);
		} catch (err) {
			logger.warn({ err, providerId, event }, '[app-trigger] sample fetch failed');
			const message = err instanceof Error ? err.message : 'Sample fetch failed.';
			const body: AppTriggerSampleResponse = { success: false, error: message };
			res.status(502).json(body);
		}
	});

	router.post('/:triggerId/register', auth, async (req: Request, res: Response) => {
		const ownerId = req.user?.sub;
		if (!ownerId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { triggerId } = req.params as { triggerId: string };
		try {
			const status = await appTriggerManager.reregister(triggerId, ownerId);
			const body: AppTriggerRegistrationResponse = { success: true, data: status };
			res.json(body);
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Re-registration failed.';
			// 'Trigger not found' is the ownership/existence guard — map to 404.
			const status = message === 'Trigger not found' ? 404 : 400;
			logger.warn({ err, triggerId }, '[app-trigger] re-registration request failed');
			const body: AppTriggerRegistrationResponse = { success: false, error: message };
			res.status(status).json(body);
		}
	});

	return router;
}
