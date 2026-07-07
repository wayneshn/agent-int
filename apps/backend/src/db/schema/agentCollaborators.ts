import { pgTable, uuid, primaryKey, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

/**
 * Junction table — the agent-to-agent messaging allow-list.
 *
 * A row (agentId, targetAgentId) means `agentId` is permitted to send messages to
 * `targetAgentId` via the list_agents / send_to_agent / ask_agent tools. The list is
 * default-deny: an agent can only reach targets explicitly linked here. Both agents
 * must belong to the same owner (enforced in the service layer via ownership checks).
 *
 * The relationship is directional — A being able to message B does not imply B can
 * message A. This maps a "team lead → workers" hierarchy where the lead can dispatch
 * but the workers cannot message the lead unless separately allowed.
 */
export const agentCollaborators = pgTable(
	'agent_collaborators',
	{
		/** The agent that is allowed to initiate messages */
		agentId: uuid('agent_id')
			.notNull()
			.references(() => agents.id, { onDelete: 'cascade' }),
		/** The agent that may be messaged by agentId */
		targetAgentId: uuid('target_agent_id')
			.notNull()
			.references(() => agents.id, { onDelete: 'cascade' }),
	},
	(table) => [
		primaryKey({ columns: [table.agentId, table.targetAgentId] }),
		index('agent_collaborators_agent_id_idx').on(table.agentId),
	],
);
