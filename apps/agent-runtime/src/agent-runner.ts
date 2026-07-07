import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import {
	type Model,
	type TextContent,
	type ImageContent,
	type UserMessage,
	type AssistantMessage,
	type ToolResultMessage,
	type ToolCall,
	type Message,
	type Context,
	type Usage,
	createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type { AgentRuntimeConfig, LlmProxyRequest } from '@repo/types';
import { logger, resolveProviderApi } from '@repo/utils';
import { ProxyClient } from './proxy-client.js';
import { createAgentTools } from './tools/index.js';
import { buildSkillsPromptSection } from './prompt-sections.js';
import { recordSkillTraces, type ToolLogEntry } from './skill-trace.js';

/** Zero-value Usage for the placeholder AssistantMessage returned by the proxy streamFn */
const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Persistent workspace root for this agent process.
 * Injected by AgentRuntimeService as WORKSPACE_ROOT — one directory per agentId.
 * Falls back to /workspace so legacy Docker deployments still work if needed.
 */
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspace';

/** Fallback tool-call cap when the agent config does not specify one (legacy configs). */
const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 20;

/**
 * Builds and runs the pi-agent Agent for a single task/conversation turn.
 *
 * Security:
 *   - No LLM API key in this process. All LLM calls go through ProxyClient.llmStream().
 *   - No credential values in this process. All API calls go through ProxyClient.proxy().
 *   - File tools are restricted to WORKSPACE_ROOT — path traversal is rejected.
 *   - run_terminal and run_code must only access files inside the workspace.
 *
 * Tool loop protection:
 *   - Hard cap of config.maxToolCallsPerTurn tool executions per turn (per-agent
 *     setting, default 20). When exceeded the tool is blocked and the agent must
 *     produce a final reply.
 *   - Proactive budget notice: as the agent nears the cap, a model-only system
 *     notice is appended to the LLM context (never persisted/shown) telling it how
 *     many calls remain and, on the last one, to deliver a result instead of
 *     continuing to try.
 *
 * Flow:
 *   1. Load conversation history from host via ProxyClient.loadMessages()
 *   2. Build tools via createAgentTools() from src/tools/
 *   3. Build pi-agent Agent with a proxy streamFn (routes LLM calls to host)
 *   4. Agent runs its tool loop — tools execute locally or via proxy
 *   5. Tool results are persisted via ProxyClient.appendToolResult()
 *   6. Agent finishes; process exits
 */
export async function runAgent(
	config: AgentRuntimeConfig,
	proxyClient: ProxyClient,
): Promise<void> {
	// ── Provider → pi-ai API identifier mapping ───────────────────────────────
	// Uses the shared resolveProviderApi from @repo/utils so this mapping stays
	// in sync with AgentLlmProxyService. The `api` field on AssistantMessage must
	// match what the host uses or pi-ai will serialise tool-call history incorrectly
	// on the second turn (after a tool execution) for non-OpenAI providers.
	const resolvedApi = resolveProviderApi(config.modelProvider ?? '');

	// ── Skill activation tracking (evolution engine traces) ──────────────────
	// A skill is "activated" when the agent reads any file under its
	// skills/<name>/ folder. One trace per activated skill is recorded at the
	// end of the turn.
	const activatedSkills = new Set<string>();
	const toolLog: ToolLogEntry[] = [];

	// ── Build all tools ───────────────────────────────────────────────────────
	const tools = createAgentTools({
		proxyClient,
		workspaceRoot: WORKSPACE_ROOT,
		agentId: config.agentId,
		skillNames: (config.skills ?? []).map((s) => s.name),
		onSkillActivated: (skillName) => activatedSkills.add(skillName),
		// Register browser tools only when the host says they are available
		// (agent has internet access + project browser feature enabled).
		browserAvailable: config.browserAvailable ?? false,
		// Register render_ui only for web-channel chat turns — external channels
		// can't display interactive UI and must get plain text.
		uiRenderingAvailable: config.uiRenderingAvailable ?? false,
		// Register agent-to-agent tools only when the agent has collaborators.
		agentMessagingAvailable: config.agentMessagingAvailable ?? false,
	});

	// ── streamFn: routes every LLM call through the host proxy ────────────────
	const streamFn: StreamFn = (model, context, options) => {
		const ctx = context as Context;
		const request: LlmProxyRequest = {
			messages: ctx.messages,
			systemPrompt: ctx.systemPrompt ?? config.systemInstruction,
			tools: ctx.tools,
			thinkingLevel: options?.reasoning,
		};

		logger.debug(
			{ messages: ctx.messages.length, tools: (ctx.tools ?? []).length },
			'[agent-runner] → LLM stream request',
		);

		const eventStream = createAssistantMessageEventStream();

		proxyClient
			.llmStream(request)
			.then((contentBlocks) => {
				const toolCalls = contentBlocks.filter((b) => b.type === 'toolCall').length;
				logger.debug(
					{ contentBlocks: contentBlocks.length, toolCalls },
					'[agent-runner] ← LLM stream response',
				);

				const content: AssistantMessage['content'] = contentBlocks.map((block) => {
					if (block.type === 'text') {
						return { type: 'text' as const, text: block.text } as TextContent;
					}
					if (block.type === 'thinking') {
						return { type: 'thinking' as const, thinking: block.thinking };
					}
					const tc = block as {
						type: 'toolCall';
						id: string;
						name: string;
						arguments: Record<string, unknown>;
					};
					return {
						type: 'toolCall' as const,
						id: tc.id,
						name: tc.name,
						arguments: tc.arguments,
					} as ToolCall;
				});

				const assistantMessage: AssistantMessage = {
					role: 'assistant',
					content,
					api: resolvedApi as AssistantMessage['api'],
					provider: config.modelProvider || 'proxy',
					model: config.modelId || 'proxy',
					usage: zeroUsage,
					stopReason: 'stop',
					timestamp: Date.now(),
				};

				eventStream.push({ type: 'done', reason: 'stop', message: assistantMessage });
				eventStream.end(assistantMessage);
			})
			.catch((err: Error) => {
				logger.error({ err }, '[agent-runner] LLM stream error');
				const errorMessage: AssistantMessage = {
					role: 'assistant',
					content: [],
					api: resolvedApi as AssistantMessage['api'],
					provider: config.modelProvider || 'proxy',
					model: config.modelId || 'proxy',
					usage: zeroUsage,
					stopReason: 'error',
					errorMessage: err.message,
					timestamp: Date.now(),
				};
				eventStream.push({ type: 'error', reason: 'error', error: errorMessage });
				eventStream.end(errorMessage);
			});

		return eventStream;
	};

	// ── Load conversation history ─────────────────────────────────────────────
	logger.debug({ threadId: config.threadId }, '[agent-runner] loading message history');
	const existingMessages = await proxyClient.loadMessages();
	logger.info(
		{ threadId: config.threadId, count: existingMessages.length, triggerType: config.triggerType },
		'[agent-runner] message history loaded',
	);

	// Convert DB messages to pi-ai Message[]
	const agentMessages: Message[] = existingMessages.map((msg) => {
		if (msg.role === 'user') {
			const userMsg: UserMessage = {
				role: 'user',
				content: msg.content
					.filter((b) => b.type === 'text' || b.type === 'image')
					.map((b) => b as TextContent | ImageContent),
				timestamp: msg.createdAt instanceof Date ? msg.createdAt.getTime() : Date.now(),
			};
			return userMsg;
		}
		if (msg.role === 'assistant') {
			const assistantMsg: AssistantMessage = {
				role: 'assistant',
				content: msg.content as AssistantMessage['content'],
				api: resolvedApi as AssistantMessage['api'],
				provider: config.modelProvider || 'proxy',
				model: config.modelId || 'proxy',
				usage: zeroUsage,
				stopReason: 'stop',
				timestamp: msg.createdAt instanceof Date ? msg.createdAt.getTime() : Date.now(),
			};
			return assistantMsg;
		}
		// tool_result
		const toolResultMsg: ToolResultMessage = {
			role: 'toolResult',
			toolCallId: msg.toolCallId ?? '',
			toolName: msg.toolName ?? '',
			content: msg.content
				.filter((b) => b.type === 'text' || b.type === 'image')
				.map((b) => b as TextContent | ImageContent),
			isError: false,
			timestamp: msg.createdAt instanceof Date ? msg.createdAt.getTime() : Date.now(),
		};
		return toolResultMsg;
	});

	// ── Build effective system prompt ─────────────────────────────────────────

	// Inject current date and time so the agent can reason about time-sensitive tasks.
	// Uses the user's browser datetime when available (chat turns), falls back to
	// server UTC time for non-chat triggers (cron, webhook, manual) where no browser is involved.
	const datetimeLine = config.userDatetime
		? `The user's current date and time is: ${config.userDatetime}`
		: `The current server time is: ${new Date().toISOString()} . ` +
			`This trigger was not initiated by a user browser session, so the user's local ` +
			`timezone is unknown. So there might be a slight difference with the current user time (a few hours top). But this might also be the same as user time.`;
	let effectiveSystemPrompt =
		`## Current Date & Time\n${datetimeLine}\n\n` + config.systemInstruction;
	if (config.credentials.length > 0) {
		// Use rich metadata (name, integration, scopes) so the model can correctly match a
		// credential to the service it was created for and know which operations are permitted.
		const credentialList = config.credentials
			.map((c) => {
				let line = `- credentialId: \`${c.id}\`  name: "${c.name}"  service: "${c.integration}"`;
				if (c.scopes) {
					line += `  scopes: "${c.scopes}"`;
				}
				// Non-secret properties (e.g. baseUrl, host, port) — critical for the agent to
				// know how to construct API request URLs for self-hosted services like Home Assistant.
				if (c.properties && Object.keys(c.properties).length > 0) {
					const propsStr = Object.entries(c.properties)
						.map(([k, v]) => `${k}="${v}"`)
						.join('  ');
					line += `  properties: ${propsStr}`;
				}
				return line;
			})
			.join('\n');
		effectiveSystemPrompt +=
			`\n\n## Available Credentials\n` +
			`The following credentials are configured for this agent and can be used with the call_api tool:\n` +
			credentialList +
			`\n\n**Rules for using credentials:**\n` +
			`- Only use a credentialId when the target API explicitly requires authentication ` +
			`AND the credential's "service" field matches the target API.\n` +
			`- When a credential has a "scopes" field, you may ONLY make API calls that are ` +
			`covered by those scopes. Do not attempt operations outside the declared scopes — ` +
			`they will be rejected by the service. If the scopes field is absent, there is no ` +
			`declared scope restriction and you may attempt the call.\n` +
			`- For public APIs that require no authentication (e.g. open weather services, ` +
			`public data endpoints, any URL that works without a key), omit credentialId ` +
			`or pass an empty string. Do NOT attach any credential to these requests.\n` +
			`- Never use a credential for a service other than the one shown in its "service" field. ` +
			`Using the wrong credential risks sending secrets to unintended third-party services.\n` +
			`- If no credential matches the target service, make the call without a credentialId.`;
	} else {
		// No credentials configured — make sure the model doesn't hallucinate credential IDs
		effectiveSystemPrompt +=
			`\n\n## Credentials\n` +
			`No credentials are configured for this agent. For any API calls, omit the ` +
			`credentialId field (pass an empty string). Only call public APIs that work ` +
			`without authentication.`;
	}

	// Inject the skill index (progressive disclosure) — full instructions live
	// in <workspace>/skills/<name>/SKILL.md, read on demand via read_file.
	effectiveSystemPrompt += buildSkillsPromptSection(config.skills);

	// Inject memory guidance if an embedding model is configured.
	// Provides clear rules for when and how to use memory tools.
	if (config.embeddingModelConfigId) {
		effectiveSystemPrompt +=
			`\n\n## Long-Term Memory\n` +
			`You have access to persistent memory tools (memory_write, memory_search) ` +
			`that let you store and recall information across sessions.\n\n` +
			`### When to use memory_search\n` +
			`- At the start of each task or conversation turn, search memory for context ` +
			`relevant to what the user is asking. Use it to recall past preferences, ` +
			`known facts about the user, ongoing projects, or prior outcomes.\n` +
			`- Be proactive: if you think past context might exist, check before proceeding.\n\n` +
			`### When to use memory_write — WRITE PROACTIVELY\n` +
			`Write a memory entry immediately when:\n` +
			`- The user shares a **preference** (e.g. "I prefer X", "always use Y format", ` +
			`"don't do Z"). Write this as **procedural**.\n` +
			`- The user shares a **personal fact** (e.g. their name, role, organisation, ` +
			`project details, goals, constraints). Write this as **semantic**.\n` +
			`- The user corrects you or gives feedback that changes how you should behave. ` +
			`Write this as **procedural**.\n` +
			`- You discover or confirm an **important fact** that will be useful in future ` +
			`sessions (domain knowledge, account details, recurring task patterns). ` +
			`Write this as **semantic**.\n` +
			`- A **significant task outcome** occurs that the user would expect you to ` +
			`remember (e.g. a document was published, a workflow was configured, a key ` +
			`decision was made). Write this as **episodic**.\n` +
			`- Use **working** only for temporary context that is only useful within ` +
			`the current session and has no long-term value.\n\n` +
			`### What NOT to write\n` +
			`- **Do NOT** write memory entries that record your own execution steps, ` +
			`tool calls made, or intermediate reasoning. Memory is not a log of what ` +
			`you did — it is knowledge that should persist and benefit future sessions.\n` +
			`- **Do NOT** write a memory entry just because you completed a task. Only ` +
			`write if there is genuinely new information worth remembering.\n` +
			`- **Do NOT** duplicate information already in memory. Check first with ` +
			`memory_search if you are unsure whether a fact is already stored.\n\n` +
			`### Format\n` +
			`Keep each memory concise and self-contained (it will be retrieved in ` +
			`isolation). Write in third-person-neutral factual style, not as a diary ` +
			`entry. Example: "User prefers responses in bullet-point format." not ` +
			`"The user told me they like bullets."`;

		// Knowledge base note — only when ready knowledge files are assigned.
		// Content lives in agent_memory (chunked + embedded), retrieved via
		// memory_search like any other memory; never injected into the prompt.
		if (config.knowledgeBase) {
			const { fileCount, fileNames } = config.knowledgeBase;
			effectiveSystemPrompt +=
				`\n\n### Knowledge Base\n` +
				`This agent has a knowledge base of ${fileCount} file(s): ` +
				`${fileNames.join(', ')}${fileCount > fileNames.length ? ', …' : ''}.\n` +
				`Its contents are stored as memory entries — retrieve them with memory_search ` +
				`(no special filter needed; search using terms related to the question). ` +
				`Each result's metadata includes fileName and location.label (e.g. "Page 3", ` +
				`"Slide 7", "Sheet 'Q1' rows 1–50"). When you use knowledge base content in ` +
				`an answer, cite the source as "<fileName>, <location label>".`;
		}
	}

	// Browser automation guidance — only when the host enabled the browser tools.
	if (config.browserAvailable) {
		effectiveSystemPrompt +=
			`\n\n## Web Browser\n` +
			`You can drive a real headless web browser to read pages and operate web ` +
			`apps (fill forms, register accounts, click through flows, take screenshots). ` +
			`The browser runs on the host — your tools send it commands and receive results.\n\n` +
			`### When to use the browser — DEFAULT TO A PLAIN FETCH FIRST\n` +
			`The browser is HEAVY (it uses many tool calls). Do NOT reach for it first. For ` +
			`most web content a lightweight HTTP fetch is faster and cheaper:\n` +
			`- **Default: fetch the page with \`curl\` via run_terminal** (e.g. ` +
			`\`curl -sL <url>\`). For APIs/JSON or large pages, the call_api tool is better ` +
			`(omit credentialId for public URLs; no size cap). If the fetched HTML or text ` +
			`already contains what you need, USE IT and do not open the browser.\n` +
			`- **Only use the browser when a plain fetch is not enough**:\n` +
			`  - the page is rendered by JavaScript (a single-page app) and curl returns an ` +
			`almost-empty HTML shell with no real content; or\n` +
			`  - you must INTERACT — fill in or submit a form, log in, click through steps, ` +
			`pick from menus, or work within a logged-in session; or\n` +
			`  - you need a screenshot or the visual layout.\n` +
			`- Rule of thumb: try curl first; fall back to the browser only when curl's ` +
			`output lacks the needed content or the task requires interaction.\n\n` +
			`### How to use it\n` +
			`1. Start with **browser_navigate** to open a URL. It waits for the page to ` +
			`load (including client-side rendering) and returns the page title and a list ` +
			`of interactive elements, each with a stable ref like "e3".\n` +
			`2. Act on those refs: **browser_click(ref)**, **browser_type(ref, text, submit?)**, ` +
			`**browser_select(ref, values)**, **browser_press_key(key)**.\n` +
			`3. Refs come ONLY from the most recent snapshot. After the page changes, call ` +
			`**browser_snapshot** again to get fresh refs before acting.\n` +
			`4. Use **browser_read_page** to read article/result text, **browser_screenshot** ` +
			`to inspect a page visually (you receive the image; pass a \`path\` to also save ` +
			`it into your workspace), and **browser_wait_for** after actions that load ` +
			`content asynchronously.\n\n` +
			`### Embedded content & dropdowns\n` +
			`- Snapshots and read_page ALSO include content inside iframes (embedded forms ` +
			`like Tally/HubSpot/Typeform, widgets, etc.). Their refs are prefixed with the ` +
			`frame, e.g. "f1e3". You do NOT need to find an iframe's URL or fetch its ` +
			`bundle — just snapshot and operate the refs directly.\n` +
			`- For custom dropdowns (role=combobox/listbox, not a native <select>), use ` +
			`**browser_select** (it opens the menu and picks the option), or click the ` +
			`field to open it, browser_snapshot to reveal the options, then browser_click one.\n\n` +
			`### Session\n` +
			`- The browser STAYS OPEN across turns in this conversation, so a follow-up ` +
			`message can keep using the page you left on. It is closed automatically when ` +
			`the conversation is idle, deleted, or hits a time limit.\n\n` +
			`### Rules\n` +
			`- Browser flows use several tool calls; plan efficiently and stop once the task ` +
			`is done. If a page cannot be operated (blocked, captcha, login wall you lack ` +
			`credentials for), tell the user honestly instead of retrying endlessly.\n` +
			`- Never use the browser to attempt to bypass authentication, scrape at abusive ` +
			`volume, or perform actions the user did not ask for.`;
	}

	// Generative UI guidance — only when the render_ui tool is registered
	// (chat turns from the web channel).
	if (config.uiRenderingAvailable) {
		effectiveSystemPrompt +=
			`\n\n## Interactive UI (render_ui)\n` +
			`You can render interactive UI directly in the chat with the render_ui tool. ` +
			`Prefer it over plain text whenever it presents the answer better:\n` +
			`- Structured data → Table, KeyValue or ListBlock (never a markdown table when ` +
			`render_ui is available)\n` +
			`- Numeric comparisons, trends or proportions → BarChart / LineChart / PieChart ` +
			`(only with real data — never invent numbers)\n` +
			`- Headline metrics → Stat tiles in a Columns row\n` +
			`- A set of choices for the user → Buttons; likely next questions → FollowUpBlock chips\n` +
			`- Collecting several inputs → a Form with validation rules (its submitted values ` +
			`come back to you as JSON in the user's next message)\n` +
			`Design the UI like a small purpose-built app: group related content in Cards, lead ` +
			`dashboards with a Columns row of Stats, use Tabs/Accordion for alternative or ` +
			`optional detail, and end with FollowUpBlock chips when natural next questions exist.\n` +
			`Guidelines: one render_ui call per logical view (combine sections in one Stack); ` +
			`keep any accompanying text to a sentence or two; never paste OpenUI Lang code into ` +
			`a plain-text reply. For long-form prose or simple one-line answers, plain text is ` +
			`still better.`;

		// Design preferences live in agent memory — only offer the workflow when
		// the memory tools are actually functional (embedding model configured).
		if (config.embeddingModelConfigId) {
			effectiveSystemPrompt +=
				`\n\n### UI design preferences\n` +
				`Users can set persistent preferences for how your UIs look (accent color, table ` +
				`density, chart style, layout taste).\n` +
				`- Before your FIRST render_ui call in a conversation, memory_search for stored UI ` +
				`design preferences (e.g. query "UI design preferences") and honor any hits by ` +
				`setting the matching component props (accent, density, variant).\n` +
				`- When the user expresses a UI design preference — "use green accents", "I prefer ` +
				`compact tables", "always show charts as donuts" — memory_write it immediately as ` +
				`type "procedural", phrased for direct reuse, e.g. "UI preference: use accent ` +
				`\\"green\\" on cards, stats and charts." Do not duplicate preferences already ` +
				`stored; if the user changes their mind, write the new preference and ` +
				`memory_delete the old one.\n` +
				`- Without a stored preference, omit accent props — the default theme accent applies.`;
		}
	}

	// ── Tool restrictions (workspace boundary + no host exploration) ──────────
	// These rules apply to all agents regardless of other configuration.
	// They constrain run_terminal and run_code to the agent workspace, prevent
	// the agent from over-using tools, and enforce graceful give-up when the
	// needed information cannot be obtained.
	effectiveSystemPrompt +=
		`\n\n## Tool Restrictions\n` +
		`These rules are mandatory and override any other instruction:\n\n` +
		`### Tool Restraint\n` +
		`- **Try once, then give up**: If a tool call fails or does not return the ` +
		`information you need, do NOT keep retrying with slight variations in an attempt ` +
		`to force a result. Attempt each action at most once or twice. If it still does ` +
		`not work, stop and tell the user honestly that you cannot complete the task with ` +
		`the available tools or information.\n` +
		`- **Default to declining**: When you are unsure whether you have the right tools, ` +
		`credentials, or data to fulfil a request, say so clearly instead of improvising ` +
		`or guessing. It is better to admit a limitation than to produce incorrect output.\n` +
		`- **No speculative probing**: Do not run sequences of exploratory tool calls ` +
		`hoping to stumble on useful information. Only call a tool when you have a clear, ` +
		`specific reason to believe it will directly help answer the user's request.\n\n` +
		`### run_code and run_terminal — Use with Caution\n` +
		`- Only call run_code or run_terminal when execution is genuinely required to ` +
		`produce the answer (e.g. actual computation, file manipulation, data processing ` +
		`the user explicitly requested, or running tests/scripts the user asked for).\n` +
		`- **FORBIDDEN — "print-as-reasoning" pattern**: NEVER write code whose sole ` +
		`purpose is to print or echo information you already know or have decided. ` +
		`This pattern adds zero value and is prohibited:\n` +
		`    BAD: print("The link is https://...")\n` +
		`    BAD: print("Potential causes: DKIM missing, SPF...")\n` +
		`    BAD: print("I will suggest the user to...")\n` +
		`    In all of these cases, you already have the answer — just write it directly ` +
		`in your reply text. Do NOT wrap known information in a print() call.\n` +
		`- **Self-test before calling**: Ask yourself: "If I deleted this tool call, could ` +
		`I still give the same answer from my own knowledge?" If YES, do not call the tool. ` +
		`Only use run_code when the execution itself produces new information you do not ` +
		`already have (e.g. computing a hash, parsing data, running a calculation).\n` +
		`- Keep commands simple and scoped to the task. Do not write scripts that probe ` +
		`system state, install packages, modify system configuration, or make unsolicited ` +
		`network requests. Fetching a public web page or API that the user's task needs ` +
		`(e.g. \`curl -sL <url>\`) is allowed when you have internet access.\n` +
		`- Never attempt to escalate privileges, bypass sandbox restrictions, or use ` +
		`creative shell tricks (e.g. base64-encoding payloads, piping to sh, using curl ` +
		`to download and execute code) to circumvent these rules.\n\n` +
		`### Workspace Boundary\n` +
		`- When using run_terminal or run_code, you may ONLY access files inside your ` +
		`workspace directory. Never read or write files at system paths such as /etc, ` +
		`/proc, /sys, /home, /root, /var, or /tmp (outside the workspace root).\n\n` +
		`### No Host Exploration\n` +
		`- Never use any tool to discover the host operating system, enumerate environment ` +
		`variables, inspect running processes, probe internal or host network endpoints, ` +
		`or probe the underlying infrastructure. (Fetching public web pages or APIs that ` +
		`the user's task requires is fine — via curl or the call_api tool.)\n\n` +
		`### No Credential Bypass\n` +
		`- Never attempt to read API keys, secrets, or tokens from the filesystem, ` +
		`environment, or process memory. All external API access must go through the ` +
		`call_api tool with an authorised credential ID.\n\n` +
		`### Ask Instead of Guessing\n` +
		`- If a task requires information you do not have (such as the user's personal ` +
		`details, account information, or private data), do not attempt to find it by ` +
		`exploring the system. Ask the user to provide it directly.`;

	// ── Tool call loop protection ─────────────────────────────────────────────
	// Uses beforeToolCall (not afterToolCall + terminate:true) because:
	//   - terminate:true skips the follow-up LLM call entirely → agent goes silent
	//   - beforeToolCall with block:true returns an error result to the LLM,
	//     which then MUST make one more LLM call to respond with text
	// This guarantees the agent always produces a visible reply after hitting the cap.
	//
	// The cap is a per-agent setting (config.maxToolCallsPerTurn); older runtime
	// configs may omit it, so fall back to the default.
	const maxToolCallsPerTurn = config.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN;
	// Begin warning the model once this many (or fewer) tool calls remain. Scales
	// with the cap so large caps still get meaningful lead time, with a 3-call floor.
	const warnRemaining = Math.max(3, Math.ceil(maxToolCallsPerTurn * 0.25));
	let toolCallCount = 0;

	// ── Build and run the Agent ───────────────────────────────────────────────
	// Placeholder model — streamFn intercepts all calls so this value is never
	// passed to any real provider.
	const placeholderModel: Model<'openai-completions'> = {
		id: config.modelId || 'proxy',
		name: 'Proxy Model',
		api: 'openai-completions',
		provider: config.modelProvider || 'proxy',
		baseUrl: '',
		reasoning: false,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	const agent = new Agent({
		initialState: {
			systemPrompt: effectiveSystemPrompt,
			model: placeholderModel,
			tools,
			messages: agentMessages,
		},
		streamFn,
		/**
		 * transformContext: proactive, model-only tool-budget notice.
		 *
		 * Runs before every LLM call. Its return value shapes ONLY that call's LLM
		 * input — it is never written back to agent.state.messages, so the host
		 * (which persists only the model's response + tool results) never stores it
		 * and the chat UI never shows it. As the agent nears the cap we append a
		 * short "[System notice]" user message to the end of the prompt telling it
		 * how many tool calls remain and, on the last one, to deliver a result now
		 * rather than keep trying. The hard stop below remains the backstop.
		 *
		 * toolCallCount is incremented in beforeToolCall, so by the next LLM call it
		 * already reflects every tool call executed so far this turn.
		 */
		transformContext: async (messages) => {
			const remaining = maxToolCallsPerTurn - toolCallCount;
			if (remaining > warnRemaining) return messages; // not near the cap — no overhead
			const text =
				remaining <= 0
					? `[System notice] You have now used all ${maxToolCallsPerTurn} of your ` +
						`${maxToolCallsPerTurn} allowed tool calls for this turn. You may NOT make any ` +
						`more tool calls. Provide your final answer to the user now using what you have ` +
						`already gathered. If you could not fully complete the task, say so honestly and ` +
						`state what is missing or what you need from the user — do not keep trying.`
					: `[System notice] You have used ${toolCallCount} of ${maxToolCallsPerTurn} tool ` +
						`calls allowed for this turn (${remaining} remaining). Start converging on a final ` +
						`answer rather than exploring further. Spend any remaining calls only on essential ` +
						`actions; if you already have enough to answer, reply now instead of calling more tools.`;
			// Return a NEW array — never mutate or persist the agent's stored messages.
			const notice: UserMessage = {
				role: 'user',
				content: [{ type: 'text', text }],
				timestamp: Date.now(),
			};
			return [...messages, notice];
		},
		/**
		 * beforeToolCall: enforces the per-agent maxToolCallsPerTurn cap.
		 *
		 * When the cap is hit, blocks the tool with an explicit reason message.
		 * The LLM receives the block as a tool error and is forced to make one
		 * final LLM call to reply to the user — guaranteeing a visible response.
		 *
		 * This is preferable to afterToolCall + terminate:true, which skips the
		 * follow-up LLM call entirely and leaves the user with no reply.
		 */
		beforeToolCall: async () => {
			toolCallCount++;
			logger.debug(
				{ toolCallCount, max: maxToolCallsPerTurn },
				'[agent-runner] tool call preflight',
			);
			if (toolCallCount > maxToolCallsPerTurn) {
				logger.warn(
					{ toolCallCount, threadId: config.threadId },
					'[agent-runner] tool call cap exceeded — blocking tool, forcing text reply',
				);
				return {
					block: true,
					reason:
						'Tool call limit reached. Stop using tools and provide a final text response ' +
						'to the user based on what you have gathered so far. ' +
						'If you cannot answer, tell the user honestly and ask them to provide more information.',
				};
			}
			return undefined;
		},
	});

	// Persist tool results to DB via proxy
	agent.subscribe(async (event) => {
		if (event.type === 'tool_execution_end') {
			logger.debug(
				{ toolName: event.toolName, toolCallId: event.toolCallId },
				'[agent-runner] tool execution end, persisting result',
			);
			// Condensed per-tool outcome for the skill execution trace
			toolLog.push({
				name: event.toolName,
				ok: !(event.result as { isError?: boolean }).isError,
			});
			const resultContent =
				(event.result as { content?: (TextContent | ImageContent)[] }).content ?? [];
			await proxyClient.appendToolResult({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				content: resultContent.map((b) => {
					if (b.type === 'text') {
						return { type: 'text' as const, text: (b as TextContent).text };
					}
					return {
						type: 'image' as const,
						data: (b as ImageContent).data,
						mimeType: (b as ImageContent).mimeType,
					};
				}),
			});
		}
	});

	// Start execution. Skill traces are recorded in the finally block so both
	// success and failure outcomes feed the evolution engine.
	let turnSucceeded = false;
	try {
		if (config.triggerType !== 'chat' && config.triggerPayload && agentMessages.length === 0) {
			const triggerText = `Trigger type: ${config.triggerType}\nPayload:\n${JSON.stringify(config.triggerPayload, null, 2)}`;
			logger.info(
				{ triggerType: config.triggerType },
				'[agent-runner] starting via trigger prompt',
			);
			await agent.prompt(triggerText);
		} else if (agentMessages.length > 0) {
			logger.info({ messageCount: agentMessages.length }, '[agent-runner] continuing from history');
			await agent.continue();
		}

		// ── Tool limit follow-up ────────────────────────────────────────────────
		// If the hard tool-call cap was hit, steer the agent to produce a final
		// response. The steer message is injected after the loop has already stopped
		// (terminate:true was returned), so this triggers exactly one additional LLM
		// call that generates an honest answer for the user.
		await agent.waitForIdle();
		turnSucceeded = true;
	} finally {
		// Awaited (not fire-and-forget) — the process exits right after this
		// function returns. Never throws.
		await recordSkillTraces(proxyClient, activatedSkills, turnSucceeded, toolCallCount, toolLog);
	}

	logger.info({ threadId: config.threadId }, '[agent-runner] agent idle — turn complete');
}
