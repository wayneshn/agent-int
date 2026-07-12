import express, { Router } from 'express';
import type { Request, Response } from 'express';
import type { WebhookAcceptedResponse } from '@repo/types';
import { TriggerService, TriggerFireError } from '../services/TriggerService.js';
import type { AppTriggerManager } from '../services/triggers/AppTriggerManager.js';
import { logger } from '../config/logger.js';

/**
 * Webhook router — public endpoints for external services to trigger agents.
 *
 * Routes:
 *   POST /v1/webhooks/:triggerId  — receive a webhook and fire the corresponding agent trigger
 *
 * Two flavours, branched on the trigger kind:
 *   - kind === 'webhook' (generic) — HMAC-SHA256 over the raw body against the stored secret
 *     (unless requireSignature === false). Headers are forwarded into {{trigger.payload}}.
 *   - kind === 'app' — delegated to AppTriggerManager: the matching push provider verifies its
 *     own inbound auth (Slack signing secret, Notion signature), answers any verification
 *     challenge, and produces the normalized event payload. Raw headers are passed to the
 *     provider (it does NOT leak them into the payload). Poll providers (Gmail, Outlook, Forms)
 *     never hit this route — they call the app's API outbound on a timer.
 *
 * Security:
 *   - No user auth — these endpoints are called by external services
 *   - Auth/validation failures return a generic 401 without revealing whether the trigger
 *     exists (anti-enumeration); the precise reason is logged
 *
 * IMPORTANT: this router must be mounted BEFORE the global express.json() middleware in
 * index.ts. Signature verification needs the raw body bytes, so the router buffers the body
 * itself with express.raw() — if the global JSON parser runs first it consumes the request
 * stream and the raw body is lost (historically this caused webhook requests to hang forever).
 */

/** Request headers that must never be forwarded into the workflow trigger payload */
const STRIPPED_HEADERS = new Set(['authorization', 'cookie', 'x-hub-signature-256']);

/** Build a sanitized headers object for {{trigger.payload}} templates (generic webhook path) */
function sanitizeHeaders(req: Request): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (STRIPPED_HEADERS.has(name)) continue;
		if (typeof value === 'string') {
			headers[name] = value;
		} else if (Array.isArray(value)) {
			headers[name] = value.join(', ');
		}
	}
	return headers;
}

/** Flatten request headers to a string map (app path — providers verify signatures, no leak) */
function flattenHeaders(req: Request): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (typeof value === 'string') headers[name] = value;
		else if (Array.isArray(value)) headers[name] = value.join(', ');
	}
	return headers;
}

/** Flatten request query params to a string map */
function flattenQuery(req: Request): Record<string, string> {
	const query: Record<string, string> = {};
	for (const [name, value] of Object.entries(req.query)) {
		if (typeof value === 'string') query[name] = value;
		else if (Array.isArray(value) && typeof value[0] === 'string') query[name] = value[0];
	}
	return query;
}

export function createWebhooksRouter(
	triggerService: TriggerService,
	appTriggerManager: AppTriggerManager,
): Router {
	const router = Router();

	/**
	 * POST /v1/webhooks/:triggerId
	 * External webhook — receives a payload and fires the agent trigger.
	 *
	 * Responses:
	 *   202 { success: true, data: { received: true, runId, workflowId } } — generic webhook run started
	 *   2xx — app-trigger acknowledgement / verification-challenge response (provider-defined)
	 *   400 — body is not valid JSON (generic webhook only)
	 *   401 — unknown trigger / disabled / wrong kind / missing or invalid signature
	 *   503 — runtime could not be started (retryable)
	 */
	router.post(
		'/:triggerId',
		// Buffer the raw body for signature verification — bounded to prevent memory abuse
		// on this unauthenticated endpoint. type: () => true buffers regardless of Content-Type.
		express.raw({ type: () => true, limit: '5mb' }),
		async (req: Request, res: Response) => {
			const { triggerId } = req.params as { triggerId: string };
			const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

			// Route by trigger kind. A lookup failure falls through to the generic path,
			// which returns the same generic 401 (anti-enumeration).
			let kind: string | null = null;
			try {
				const trigger = await triggerService.getByIdInternal(triggerId);
				kind = trigger?.kind ?? null;
			} catch {
				kind = null;
			}

			// ── App-trigger path ──
			if (kind === 'app') {
				try {
					const result = await appTriggerManager.handleInboundWebhook(triggerId, {
						rawBody,
						headers: flattenHeaders(req),
						query: flattenQuery(req),
					});
					if (result.body === undefined) {
						res.status(result.status).end();
					} else {
						res.status(result.status).json(result.body);
					}
				} catch (err) {
					logger.error({ err, triggerId }, '[webhooks] app trigger processing error');
					res.status(500).json({ success: false, error: 'Internal error' });
				}
				return;
			}

			// ── Generic webhook path ──
			const signature = req.headers['x-hub-signature-256'] as string | undefined;
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
			} catch {
				res.status(400).json({ success: false, error: 'Invalid JSON body' });
				return;
			}

			try {
				const result = await triggerService.fireWebhookTrigger(
					triggerId,
					signature,
					rawBody,
					body,
					sanitizeHeaders(req),
				);

				const response: WebhookAcceptedResponse = {
					success: true,
					data: { received: true, runId: result.runId, workflowId: result.workflowId },
				};
				res.status(202).json(response);
			} catch (err) {
				if (err instanceof TriggerFireError) {
					if (err.code === 'spawn_failed') {
						logger.error({ triggerId, message: err.message }, '[webhooks] runtime spawn failed');
						res.status(503).json({
							success: false,
							error: 'The workflow could not be started. Please retry later.',
						});
						return;
					}
					// not_found / disabled / wrong_kind / bad_signature — generic 401 so callers
					// cannot probe which trigger IDs exist. Real reason is logged.
					logger.warn(
						{ triggerId, code: err.code, message: err.message },
						'[webhooks] webhook rejected',
					);
					res.status(401).json({ success: false, error: 'Unauthorized' });
					return;
				}

				logger.error({ err, triggerId }, '[webhooks] webhook processing error');
				res.status(500).json({ success: false, error: 'Internal error' });
			}
		},
	);

	return router;
}
