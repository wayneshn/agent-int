import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TSchema } from '@earendil-works/pi-ai';
import type { TextContent, ImageContent } from '@earendil-works/pi-ai';
import type { McpServerRuntimeEntry, McpToolDescriptor } from '@repo/types';
import { logger } from '@repo/utils';
import type { ToolContext } from './types.js';

/**
 * MCP tools — dynamically built from the enabled tool metadata the backend
 * embedded in AgentRuntimeConfig.mcpServers. Each tool is namespaced
 * `mcp__<serverSlug>__<toolName>` (so tools from different servers never
 * collide) and its execute() proxies to POST /internal/mcp/call-tool, where
 * McpService holds the live connection and re-checks authorization.
 *
 * The MCP `inputSchema` is already JSON Schema, so it is passed straight through
 * as the tool's `parameters` — pi-ai serializes plain JSON Schema to the provider
 * and validates arguments against it (no TypeBox conversion needed). We only
 * normalize it to guarantee a top-level object schema.
 */

/** Ensure a top-level `{ type: 'object', properties, ... }` schema for the provider. */
function normalizeSchema(inputSchema: Record<string, unknown>): TSchema {
	const schema =
		inputSchema && inputSchema.type === 'object'
			? inputSchema
			: { type: 'object', properties: {}, ...(inputSchema ?? {}) };
	if (!('properties' in schema)) {
		(schema as Record<string, unknown>).properties = {};
	}
	return schema as unknown as TSchema;
}

function buildTool(
	ctx: ToolContext,
	server: McpServerRuntimeEntry,
	descriptor: McpToolDescriptor,
): AgentTool {
	const name = `mcp__${server.slug}__${descriptor.name}`;
	return {
		name,
		label: `${server.name}: ${descriptor.name}`,
		description:
			descriptor.description ?? `Tool "${descriptor.name}" from the "${server.name}" MCP server.`,
		parameters: normalizeSchema(descriptor.inputSchema),
		execute: async (_toolCallId, params) => {
			const content: (TextContent | ImageContent)[] = [];
			try {
				const result = await ctx.proxyClient.mcpCallTool({
					serverId: server.id,
					toolName: descriptor.name,
					args: (params ?? {}) as Record<string, unknown>,
				});
				if (result.text) content.push({ type: 'text', text: result.text });
				if (result.images) {
					for (const img of result.images) {
						content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
					}
				}
				if (content.length === 0) {
					content.push({
						type: 'text',
						text: result.isError ? 'Tool returned an error.' : 'Done.',
					});
				}
				return { content, details: {} };
			} catch (err) {
				// Errors are returned as text (never thrown) so the agent loop can react.
				const message = err instanceof Error ? err.message : String(err);
				logger.warn({ err, tool: name }, '[agent-runner] MCP tool call failed');
				return { content: [{ type: 'text', text: `${name} failed: ${message}` }], details: {} };
			}
		},
	};
}

/** Build every MCP tool from the assigned servers in the runtime config. */
export function createMcpTools(ctx: ToolContext): AgentTool[] {
	if (!ctx.mcpServers?.length) return [];
	const tools: AgentTool[] = [];
	for (const server of ctx.mcpServers) {
		for (const descriptor of server.tools) {
			tools.push(buildTool(ctx, server, descriptor));
		}
	}
	return tools;
}
