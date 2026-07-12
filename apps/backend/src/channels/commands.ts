import { logger } from '../config/logger.js';
import type { AgentThread, ChannelLink } from '@repo/types';
import type { ChannelService } from '../services/ChannelService.js';
import type { AgentService } from '../services/AgentService.js';
import type { AgentSessionService } from '../services/AgentSessionService.js';
import type { AgentLlmProxyService } from '../services/AgentLlmProxyService.js';

// ─── /pair brute-force protection ─────────────────────────────────────────────

/** Max failed /pair attempts per external identity within the window */
const MAX_PAIR_ATTEMPTS = 5;
/** Window after which failed-attempt counters reset (ms) */
const PAIR_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

/**
 * In-memory failed /pair attempt counter keyed by `${channel}:${externalId}`.
 * Pairing attempts arrive through bot adapters (long poll / WebSocket), not HTTP,
 * so the Express rate limiter never sees them — this is the only guard against
 * brute-forcing pairing codes from a chat client.
 */
const pairAttempts = new Map<string, { count: number; resetAt: number }>();

function isPairRateLimited(key: string): boolean {
	const entry = pairAttempts.get(key);
	if (!entry) return false;
	if (Date.now() > entry.resetAt) {
		pairAttempts.delete(key);
		return false;
	}
	return entry.count >= MAX_PAIR_ATTEMPTS;
}

function recordFailedPairAttempt(key: string): void {
	const now = Date.now();
	const entry = pairAttempts.get(key);
	if (!entry || now > entry.resetAt) {
		pairAttempts.set(key, { count: 1, resetAt: now + PAIR_ATTEMPT_WINDOW_MS });
		return;
	}
	entry.count += 1;
}

/** A Discord slash command option definition (type 3 = STRING) */
export interface ChannelCommandOption {
	name: string;
	description: string;
	required: boolean;
}

/**
 * The canonical list of channel bot commands with short descriptions.
 * Used by both Telegram (setMyCommands) and Discord (global application commands)
 * to register autocomplete hints that appear when the user types /.
 *
 * Telegram descriptions max 256 chars. Discord descriptions 1–100 chars.
 * Keep them under 100 chars so they work for both platforms.
 *
 * options: Discord slash command parameters. Telegram ignores this field.
 */
export const CHANNEL_COMMANDS: Array<{
	command: string;
	description: string;
	options?: ChannelCommandOption[];
}> = [
	{
		command: 'pair',
		description: 'Link your account using a pairing code from the web app',
		options: [
			{ name: 'code', description: 'Pairing code from Account → Channels', required: true },
		],
	},
	{ command: 'agents', description: 'List your available agents' },
	{
		command: 'use',
		description: 'Switch to a different agent',
		options: [
			{
				name: 'agent',
				description: 'Number from /agents, or the agent name',
				required: true,
			},
		],
	},
	{ command: 'new', description: 'Start a new conversation session' },
	{ command: 'sessions', description: 'List recent sessions for the active agent' },
	{
		command: 'session',
		description: 'Switch to a previous session by number',
		options: [
			{ name: 'number', description: 'Session number from the /sessions list', required: true },
		],
	},
	{ command: 'status', description: 'Show current agent, thread mode and settings' },
	{
		command: 'compact',
		description: 'Summarize and shrink the current conversation to free up context',
	},
	{ command: 'unpair', description: 'Disconnect this bot from your account' },
	{ command: 'help', description: 'Show all available commands' },
];

/**
 * Context for executing a channel command.
 * Platform-agnostic: the caller passes a `sendReply` function that sends
 * a text message back on the appropriate platform (Telegram, Discord, etc.).
 */
export interface ChannelCommandContext {
	channelService: ChannelService;
	agentService: AgentService;
	sessionService: AgentSessionService;
	llmProxyService: AgentLlmProxyService;
	/** Platform channel identifier — 'telegram' | 'whatsapp' | 'discord' */
	channel: string;
	/** Platform-specific sender ID (Telegram chat_id, Discord userId, etc.) */
	externalId: string;
	/** Optional sender display name (for pairing record) */
	displayName?: string;
	/** Bot's credentialId — stored on the channel_link when pairing */
	credentialId?: string;
	/**
	 * Send a reply back to the user on the originating platform.
	 * The adapter wraps this with the platform-specific send method.
	 */
	sendReply(text: string): Promise<void>;
}

/**
 * Handle an inbound text message as a potential channel command.
 *
 * Returns true if the text was a recognised command and was handled internally.
 * Returns false if the text should be forwarded to the MessagePipeline as a
 * regular user message.
 *
 * Command format: /command [arg1] [arg2] ...
 * Bot username suffixes are stripped: /start@mybotname → /start
 */
export async function handleChannelCommand(
	text: string,
	ctx: ChannelCommandContext,
): Promise<boolean> {
	const trimmed = text.trim();
	if (!trimmed.startsWith('/')) return false;

	// Strip bot @username suffix (e.g. /start@mybotname → /start)
	const firstWord = trimmed.split(/\s+/)[0].split('@')[0].toLowerCase();
	const args = trimmed.split(/\s+/).slice(1);

	switch (firstWord) {
		case '/start':
		case '/help':
			await cmdHelp(ctx);
			return true;

		case '/pair':
			await cmdPair(args, ctx);
			return true;

		case '/unpair':
			await cmdUnpair(ctx);
			return true;

		case '/agents':
			await cmdAgents(ctx);
			return true;

		case '/use':
			await cmdUse(args, ctx);
			return true;

		case '/new':
			await cmdNew(ctx);
			return true;

		case '/sessions':
			await cmdSessions(ctx);
			return true;

		case '/session':
			await cmdSession(args, ctx);
			return true;

		case '/status':
			await cmdStatus(ctx);
			return true;

		case '/compact':
			await cmdCompact(ctx);
			return true;

		default:
			// Not a system command — pass to the pipeline so the agent can handle it
			return false;
	}
}

// ─── Command implementations ──────────────────────────────────────────────────

async function cmdHelp(ctx: ChannelCommandContext): Promise<void> {
	await ctx.sendReply(
		'Available commands:\n\n' +
			'/pair <CODE> — Link your account with a pairing code from the web app\n' +
			'/agents — List your available agents\n' +
			'/use <number or name> — Switch to a different agent\n' +
			'/new — Start a new conversation session\n' +
			'/sessions — List recent sessions for the active agent\n' +
			'/session <number> — Switch to a previous session\n' +
			'/status — Show current agent and settings\n' +
			'/compact — Summarize and shrink the current conversation to free up context\n' +
			'/unpair — Disconnect this bot from your account\n' +
			'/help — Show this message\n\n' +
			'To get started, visit Account → Channels in the web app to generate a pairing code.',
	);
}

async function cmdPair(args: string[], ctx: ChannelCommandContext): Promise<void> {
	const code = args[0]?.toUpperCase();
	if (!code) {
		await ctx.sendReply(
			'Usage: /pair <CODE>\n\nGenerate a code at Account → Channels in the web app.',
		);
		return;
	}

	const attemptKey = `${ctx.channel}:${ctx.externalId}`;
	if (isPairRateLimited(attemptKey)) {
		await ctx.sendReply('❌ Too many failed pairing attempts. Please wait a few minutes and try again.');
		return;
	}

	try {
		const pairingCode = await ctx.channelService.consumePairingCode(code, ctx.channel);

		if (!pairingCode) {
			recordFailedPairAttempt(attemptKey);
			await ctx.sendReply(
				'❌ Invalid, expired, or already-used pairing code. Please generate a new one.',
			);
			return;
		}

		pairAttempts.delete(attemptKey);

		await ctx.channelService.upsertLink({
			userId: pairingCode.userId,
			channel: ctx.channel,
			externalId: ctx.externalId,
			agentId: pairingCode.agentId,
			credentialId: pairingCode.credentialId ?? ctx.credentialId,
			displayName: ctx.displayName,
		});

		const agents = await ctx.agentService.listByOwner(pairingCode.userId);
		const agent = agents.find((a) => a.id === pairingCode.agentId);
		const agentName = agent?.name ?? 'your agent';

		await ctx.sendReply(
			`✅ Paired! You're now talking to ${agentName}.\n\nSend any message to start chatting, or use /help for commands.`,
		);

		logger.info(
			{ channel: ctx.channel, externalId: ctx.externalId, userId: pairingCode.userId },
			'[channel-commands] paired',
		);
	} catch (err) {
		logger.error(
			{ err, channel: ctx.channel, externalId: ctx.externalId },
			'[channel-commands] pair failed',
		);
		await ctx.sendReply('❌ Pairing failed. Please try again.');
	}
}

async function cmdUnpair(ctx: ChannelCommandContext): Promise<void> {
	try {
		const link = await ctx.channelService.getLinkByExternalId(ctx.channel, ctx.externalId);
		if (!link) {
			await ctx.sendReply('This account is not paired.');
			return;
		}

		await ctx.channelService.deleteLink(link.id, link.userId);
		await ctx.sendReply('✅ Unpaired. Your account has been disconnected.');
		logger.info(
			{ channel: ctx.channel, externalId: ctx.externalId },
			'[channel-commands] unpaired',
		);
	} catch (err) {
		logger.error(
			{ err, channel: ctx.channel, externalId: ctx.externalId },
			'[channel-commands] unpair failed',
		);
		await ctx.sendReply('❌ Failed to unpair. Please try again.');
	}
}

async function cmdAgents(ctx: ChannelCommandContext): Promise<void> {
	const link = await ctx.channelService.getLinkByExternalId(ctx.channel, ctx.externalId);
	if (!link) {
		await sendPleaseConnect(ctx);
		return;
	}

	try {
		const agents = await ctx.agentService.listByOwner(link.userId);
		if (agents.length === 0) {
			await ctx.sendReply('You have no agents. Create one in the web app.');
			return;
		}

		const list = agents
			.map((a, i) => `${i + 1}. ${a.id === link.agentId ? '✅ ' : ''}${a.name}`)
			.join('\n');

		await ctx.sendReply(`Your agents:\n\n${list}\n\nUse /use <number or name> to switch.`);
	} catch (err) {
		logger.error({ err }, '[channel-commands] /agents failed');
		await ctx.sendReply('❌ Failed to list agents.');
	}
}

async function cmdUse(args: string[], ctx: ChannelCommandContext): Promise<void> {
	const link = await ctx.channelService.getLinkByExternalId(ctx.channel, ctx.externalId);
	if (!link) {
		await sendPleaseConnect(ctx);
		return;
	}

	const query = args.join(' ').trim();
	if (!query) {
		await ctx.sendReply('Usage: /use <number or agent name>\n\nUse /agents to see the list.');
		return;
	}

	try {
		// Same ordering as /agents, so the numbers shown there stay addressable.
		const agents = await ctx.agentService.listByOwner(link.userId);

		let agent;
		if (/^\d+$/.test(query)) {
			// Numeric → index into the /agents list (1-based).
			const idx = parseInt(query, 10);
			agent = agents[idx - 1];
			if (!agent) {
				await ctx.sendReply(`❌ No agent #${idx} found. Use /agents to see your agents.`);
				return;
			}
		} else {
			// Otherwise match by name (exact, then partial).
			agent =
				agents.find((a) => a.name.toLowerCase() === query.toLowerCase()) ??
				agents.find((a) => a.name.toLowerCase().includes(query.toLowerCase()));
			if (!agent) {
				await ctx.sendReply(
					`❌ No agent found matching "${query}". Use /agents to see your agents.`,
				);
				return;
			}
		}

		// Switch agent + start a new thread
		const thread = await ctx.sessionService.createThread({
			agentId: agent.id,
			ownerId: link.userId,
		});
		await ctx.channelService.updateLink(link.id, link.userId, { agentId: agent.id });
		await ctx.channelService.setActiveThread(link.id, thread.id);

		await ctx.sendReply(`✅ Switched to ${agent.name}. New conversation started.`);

		logger.info(
			{ channel: ctx.channel, agentId: agent.id, threadId: thread.id },
			'[channel-commands] switched agent',
		);
	} catch (err) {
		logger.error({ err }, '[channel-commands] /use failed');
		await ctx.sendReply('❌ Failed to switch agent.');
	}
}

async function cmdNew(ctx: ChannelCommandContext): Promise<void> {
	const link = await ctx.channelService.getLinkByExternalId(ctx.channel, ctx.externalId);
	if (!link) {
		await sendPleaseConnect(ctx);
		return;
	}

	try {
		const thread = await ctx.sessionService.createThread({
			agentId: link.agentId,
			ownerId: link.userId,
		});
		await ctx.channelService.setActiveThread(link.id, thread.id);

		const agents = await ctx.agentService.listByOwner(link.userId);
		const agent = agents.find((a) => a.id === link.agentId);
		const agentName = agent?.name ?? 'agent';

		await ctx.sendReply(`✅ New conversation started with ${agentName}.`);

		logger.info(
			{ channel: ctx.channel, agentId: link.agentId, threadId: thread.id },
			'[channel-commands] new thread',
		);
	} catch (err) {
		logger.error({ err }, '[channel-commands] /new failed');
		await ctx.sendReply('❌ Failed to start new conversation.');
	}
}

async function cmdCompact(ctx: ChannelCommandContext): Promise<void> {
	const link = await ctx.channelService.getLinkByExternalId(ctx.channel, ctx.externalId);
	if (!link) {
		await sendPleaseConnect(ctx);
		return;
	}
	if (!link.activeThreadId) {
		await ctx.sendReply('No active conversation to compact. Send a message or use /new first.');
		return;
	}

	try {
		await ctx.sendReply('⏳ Compacting the conversation…');
		const updated = await ctx.llmProxyService.compactThread(
			link.agentId,
			link.activeThreadId,
			link.userId,
		);
		await ctx.sendReply(
			`✅ Context compacted. The earlier conversation was summarized` +
				`${updated.contextTokens ? ` (~${updated.contextTokens} tokens now).` : '.'}`,
		);
		logger.info(
			{ channel: ctx.channel, agentId: link.agentId, threadId: link.activeThreadId },
			'[channel-commands] compacted context',
		);
	} catch (err) {
		// compactThread throws user-facing messages (running turn, nothing to compact, …)
		const message = err instanceof Error ? err.message : 'Failed to compact context';
		logger.warn({ err, channel: ctx.channel }, '[channel-commands] /compact failed');
		await ctx.sendReply(`❌ ${message}`);
	}
}

/** Max sessions shown by /sessions (and addressable via /session <number>) */
const MAX_SESSIONS_LISTED = 10;

/**
 * Fetch the most recent chat sessions (threads) for the link's active agent.
 * Workflow threads are excluded — they are not interactive conversations.
 * The ordering (newest first) must be identical for /sessions and /session
 * so the displayed numbers stay addressable.
 */
async function listRecentSessions(
	ctx: ChannelCommandContext,
	link: ChannelLink,
): Promise<AgentThread[]> {
	const threads = await ctx.sessionService.listThreads(link.agentId, link.userId);
	return threads.filter((t) => !t.isWorkflowThread).slice(0, MAX_SESSIONS_LISTED);
}

function sessionTitle(thread: AgentThread): string {
	return thread.title?.trim() || 'Untitled session';
}

async function cmdSessions(ctx: ChannelCommandContext): Promise<void> {
	const link = await ctx.channelService.getLinkByExternalId(ctx.channel, ctx.externalId);
	if (!link) {
		await sendPleaseConnect(ctx);
		return;
	}

	try {
		const sessions = await listRecentSessions(ctx, link);
		if (sessions.length === 0) {
			await ctx.sendReply('No sessions yet. Send any message to start one, or use /new.');
			return;
		}

		const list = sessions
			.map((t, i) => `${i + 1}. ${t.id === link.activeThreadId ? '✅ ' : ''}${sessionTitle(t)}`)
			.join('\n');

		await ctx.sendReply(`Recent sessions:\n\n${list}\n\nUse /session <number> to switch.`);
	} catch (err) {
		logger.error({ err }, '[channel-commands] /sessions failed');
		await ctx.sendReply('❌ Failed to list sessions.');
	}
}

async function cmdSession(args: string[], ctx: ChannelCommandContext): Promise<void> {
	const link = await ctx.channelService.getLinkByExternalId(ctx.channel, ctx.externalId);
	if (!link) {
		await sendPleaseConnect(ctx);
		return;
	}

	const num = parseInt(args[0] ?? '', 10);
	if (!Number.isInteger(num) || num < 1) {
		await ctx.sendReply('Usage: /session <number>\n\nUse /sessions to see the list.');
		return;
	}

	try {
		const sessions = await listRecentSessions(ctx, link);
		const target = sessions[num - 1];
		if (!target) {
			await ctx.sendReply(`❌ No session #${num} found. Use /sessions to see the list.`);
			return;
		}

		await ctx.channelService.setActiveThread(link.id, target.id);
		await ctx.sendReply(`✅ Switched to session: ${sessionTitle(target)}`);

		logger.info(
			{ channel: ctx.channel, threadId: target.id },
			'[channel-commands] switched session',
		);
	} catch (err) {
		logger.error({ err }, '[channel-commands] /session failed');
		await ctx.sendReply('❌ Failed to switch session.');
	}
}

async function cmdStatus(ctx: ChannelCommandContext): Promise<void> {
	const link = await ctx.channelService.getLinkByExternalId(ctx.channel, ctx.externalId);
	if (!link) {
		await sendPleaseConnect(ctx);
		return;
	}

	try {
		const agents = await ctx.agentService.listByOwner(link.userId);
		const agent = agents.find((a) => a.id === link.agentId);
		const agentName = agent?.name ?? 'Unknown';
		const mode =
			link.threadMode === 'per_session'
				? `per session (${link.sessionTimeoutMin}min)`
				: 'persistent';
		const toolNotif = link.notifyToolUsage ? 'on' : 'off';

		await ctx.sendReply(
			`Status\n\nAgent: ${agentName}\nThread mode: ${mode}\nTool notifications: ${toolNotif}`,
		);
	} catch (err) {
		logger.error({ err }, '[channel-commands] /status failed');
		await ctx.sendReply('❌ Failed to get status.');
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sendPleaseConnect(ctx: ChannelCommandContext): Promise<void> {
	await ctx.sendReply(
		'This bot is not linked to any account yet.\n\nPlease visit Account → Channels in the web app to generate a pairing code, then send:\n/pair <CODE>',
	);
}
