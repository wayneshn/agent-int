import { Router } from 'express';
import type { Request, Response } from 'express';
import { AuthService } from '../services/AuthService.js';
import { NotificationService } from '../services/NotificationService.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../config/logger.js';
import type { NotificationsListResponse, NotificationReadResponse } from '@repo/types';

/**
 * Notification routes — the web app's notification bell.
 *   GET  /v1/notifications            — newest-first list + unread count (?unread=1, ?limit=N)
 *   POST /v1/notifications/:id/read   — mark one as read
 *   POST /v1/notifications/read-all   — mark all as read
 */
export function createNotificationsRouter(
	authService: AuthService,
	notificationService: NotificationService,
): Router {
	const router = Router();
	const auth = requireAuth(authService);

	router.get('/', auth, async (req: Request, res: Response) => {
		const userId = req.user?.sub;
		if (!userId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		try {
			const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
			const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
			const data = await notificationService.listForUser(userId, { limit, unreadOnly });
			const response: NotificationsListResponse = { success: true, data };
			res.json(response);
		} catch (err) {
			logger.error({ err, userId }, '[notifications] list failed');
			res.status(500).json({ success: false, error: 'Failed to load notifications' });
		}
	});

	router.post('/read-all', auth, async (req: Request, res: Response) => {
		const userId = req.user?.sub;
		if (!userId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		try {
			await notificationService.markAllRead(userId);
			const response: NotificationReadResponse = { success: true, data: { updated: true } };
			res.json(response);
		} catch (err) {
			logger.error({ err, userId }, '[notifications] read-all failed');
			res.status(500).json({ success: false, error: 'Failed to update notifications' });
		}
	});

	router.post('/:id/read', auth, async (req: Request, res: Response) => {
		const userId = req.user?.sub;
		if (!userId) {
			res.status(401).json({ success: false, error: 'Unauthorized' });
			return;
		}
		const { id } = req.params as { id: string };
		try {
			const updated = await notificationService.markRead(id, userId);
			const response: NotificationReadResponse = { success: true, data: { updated } };
			res.json(response);
		} catch (err) {
			logger.error({ err, userId, id }, '[notifications] mark read failed');
			res.status(500).json({ success: false, error: 'Failed to update the notification' });
		}
	});

	return router;
}
