import { Router } from 'express';
import type { Request, Response } from 'express';
import type { HealthResponse, HealthApiResponse } from '@repo/types';

export const healthRouter = Router();

// GET /health — basic health check endpoint.
// `version` is the commit the image was built from (Dockerfile ARG GIT_SHA →
// ENV APP_VERSION), so a running container can be matched to a commit directly
// instead of inferring it from build artefacts.
healthRouter.get('/', (_req: Request, res: Response) => {
	const data: HealthResponse = {
		status: 'ok',
		timestamp: new Date().toISOString(),
		version: process.env.APP_VERSION ?? 'unknown',
	};
	const body: HealthApiResponse = { success: true, data };
	res.json(body);
});
