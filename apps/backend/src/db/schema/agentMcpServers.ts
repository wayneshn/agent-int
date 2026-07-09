import { pgTable, uuid, jsonb, primaryKey, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { mcpServers } from './mcpServers.js';

/**
 * Junction table — maps which MCP servers each agent may use. Assigning a server
 * to an agent exposes that server's enabled tools on the agent's turns.
 *
 * `enabledTools` optionally narrows the exposed tools for THIS agent (a subset of
 * the server's own enabled tools). Null means "inherit the server default" (all of
 * the server's enabled tools). Used to keep per-agent context/token cost in check.
 */
export const agentMcpServers = pgTable(
	'agent_mcp_servers',
	{
		agentId: uuid('agent_id')
			.notNull()
			.references(() => agents.id, { onDelete: 'cascade' }),
		mcpServerId: uuid('mcp_server_id')
			.notNull()
			.references(() => mcpServers.id, { onDelete: 'cascade' }),
		/** Per-agent tool allow-list (subset of the server's enabled tools). Null = inherit. */
		enabledTools: jsonb('enabled_tools').$type<string[]>(),
	},
	(table) => [
		primaryKey({ columns: [table.agentId, table.mcpServerId] }),
		index('agent_mcp_servers_agent_id_idx').on(table.agentId),
	],
);
