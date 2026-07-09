import type { ApiResponse } from './api.js';

/**
 * In-app notification delivered to a user — the always-on leg of proactive
 * outbound delivery (channel pushes to Telegram/Discord are best-effort extras).
 */
export interface AppNotification {
	id: string;
	userId: string;
	/** Agent that produced the notification, when applicable */
	agentId?: string;
	/** Mission the notification belongs to, when applicable */
	missionId?: string;
	/** Category tag, e.g. 'mission_report', 'mission_paused', 'approval_requested' */
	type: string;
	title: string;
	body?: string;
	/** Root-relative deep link into the web app (e.g. /app/agents/x/missions/y) */
	linkPath?: string;
	isRead: boolean;
	createdAt: Date;
}

/** GET /v1/notifications */
export interface NotificationsListData {
	notifications: AppNotification[];
	unreadCount: number;
}

export type NotificationsListResponse = ApiResponse<NotificationsListData>;
export type NotificationReadResponse = ApiResponse<{ updated: boolean }>;
