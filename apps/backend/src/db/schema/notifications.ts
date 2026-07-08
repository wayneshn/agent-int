import { pgTable, uuid, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * In-app notifications — the always-on leg of proactive outbound delivery.
 * Written by OutboundDeliveryService (mission reports, budget pauses, approval
 * requests, …); surfaced by the web app's notification bell. Channel pushes
 * (Telegram/Discord) are best-effort extras layered on top.
 *
 * `type` is plain text (e.g. 'mission_report', 'mission_paused',
 * 'approval_requested') so new categories need no migration.
 */
export const notifications = pgTable(
	'notifications',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** Agent that produced the notification, when applicable */
		agentId: uuid('agent_id'),
		/** Mission the notification belongs to, when applicable */
		missionId: uuid('mission_id'),
		type: text('type').notNull(),
		title: text('title').notNull(),
		body: text('body'),
		/** Root-relative deep link into the web app (e.g. /app/agents/x/missions/y) */
		linkPath: text('link_path'),
		isRead: boolean('is_read').notNull().default(false),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		index('notifications_user_read_created_idx').on(table.userId, table.isRead, table.createdAt),
	],
);
