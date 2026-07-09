import {
	pgTable,
	uuid,
	varchar,
	text,
	timestamp,
	boolean,
	jsonb,
	index,
	unique,
} from 'drizzle-orm/pg-core';
import type { McpToolCacheEntry } from '@repo/types';

/**
 * MCP servers — external Model Context Protocol servers a user has registered.
 * Each server is owner-scoped and, once assigned to an agent, contributes its
 * enabled tools (namespaced `mcp__<slug>__<tool>`) to that agent's turns.
 *
 * The `data` column is an AES-encrypted JSON blob (via EncryptionService) that
 * holds all secrets — static auth headers/bearer tokens, stdio command/env, and
 * OAuth client credentials/tokens. Secrets NEVER enter the agent runtime: the
 * sandbox only ever asks the backend to invoke a tool by name, and McpService —
 * which holds the live connection — injects the auth host-side.
 */
export const mcpServers = pgTable(
	'mcp_servers',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: uuid('owner_id').notNull(),
		name: varchar('name', { length: 255 }).notNull(),
		/** URL-safe identifier used to namespace tool names (unique per owner). */
		slug: varchar('slug', { length: 128 }).notNull(),
		/** 'http' (Streamable HTTP) | 'sse' (legacy) | 'stdio' (local package, phase 4). */
		transport: varchar('transport', { length: 16 }).notNull(),
		/** Remote endpoint URL. Null for stdio servers. */
		url: text('url'),
		/** 'none' | 'header' (static token) | 'oauth' (OAuth 2.1, phase 2). */
		authType: varchar('auth_type', { length: 16 }).notNull().default('none'),
		/** AES-encrypted JSON blob of all secrets — see McpServerData. */
		data: text('data').notNull(),
		/** When false, the server is ignored entirely (not connected, no tools). */
		enabled: boolean('enabled').notNull().default(true),
		/** Last known connection status, updated by test/connect. */
		status: varchar('status', { length: 16 }).notNull().default('unknown'),
		/** Last connection error message (null when healthy). */
		lastError: text('last_error'),
		/**
		 * Cached discovered tools with per-tool enable flags. Populated by a
		 * successful connect/test so buildRuntimeConfig can embed enabled tool
		 * metadata into the runtime config without opening a live connection.
		 */
		toolsCache: jsonb('tools_cache').$type<McpToolCacheEntry[]>(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').defaultNow().notNull(),
	},
	(table) => [
		index('mcp_servers_owner_id_idx').on(table.ownerId),
		unique('mcp_servers_owner_slug_uq').on(table.ownerId, table.slug),
	],
);
