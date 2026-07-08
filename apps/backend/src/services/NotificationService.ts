import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { notifications } from '../db/schema/index.js';
import type { AppNotification } from '@repo/types';

// ─── Mappers ──────────────────────────────────────────────────────────────────

function rowToNotification(row: typeof notifications.$inferSelect): AppNotification {
	return {
		id: row.id,
		userId: row.userId,
		agentId: row.agentId ?? undefined,
		missionId: row.missionId ?? undefined,
		type: row.type,
		title: row.title,
		body: row.body ?? undefined,
		linkPath: row.linkPath ?? undefined,
		isRead: row.isRead,
		createdAt: row.createdAt,
	};
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * In-app notification persistence — created by OutboundDeliveryService, read by
 * the web app's notification bell (GET /v1/notifications).
 */
export class NotificationService {
	async create(input: {
		userId: string;
		agentId?: string;
		missionId?: string;
		type: string;
		title: string;
		body?: string;
		linkPath?: string;
	}): Promise<AppNotification> {
		const [row] = await db
			.insert(notifications)
			.values({
				userId: input.userId,
				agentId: input.agentId ?? null,
				missionId: input.missionId ?? null,
				type: input.type,
				title: input.title,
				body: input.body ?? null,
				linkPath: input.linkPath ?? null,
			})
			.returning();
		return rowToNotification(row);
	}

	/** Newest-first notifications for a user, plus the unread count */
	async listForUser(
		userId: string,
		opts: { limit?: number; unreadOnly?: boolean } = {},
	): Promise<{ notifications: AppNotification[]; unreadCount: number }> {
		const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
		const conditions = [eq(notifications.userId, userId)];
		if (opts.unreadOnly) conditions.push(eq(notifications.isRead, false));
		const [rows, countRows] = await Promise.all([
			db
				.select()
				.from(notifications)
				.where(and(...conditions))
				.orderBy(desc(notifications.createdAt))
				.limit(limit),
			db
				.select({ count: sql<number>`count(*)::int` })
				.from(notifications)
				.where(and(eq(notifications.userId, userId), eq(notifications.isRead, false))),
		]);
		return { notifications: rows.map(rowToNotification), unreadCount: countRows[0]?.count ?? 0 };
	}

	async markRead(id: string, userId: string): Promise<boolean> {
		const result = await db
			.update(notifications)
			.set({ isRead: true })
			.where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
		return (result.rowCount ?? 0) > 0;
	}

	async markAllRead(userId: string): Promise<number> {
		const result = await db
			.update(notifications)
			.set({ isRead: true })
			.where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
		return result.rowCount ?? 0;
	}
}
