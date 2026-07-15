import type { Agent, StreamFn } from '@earendil-works/pi-agent-core';
import {
	type AssistantMessage,
	type TextContent,
	type ToolCall,
	type Context,
	type Usage,
	createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type { AgentRuntimeConfig, LlmProxyRequest } from '@repo/types';
import { logger, resolveProviderApi } from '@repo/utils';
import { ProxyClient } from './proxy-client.js';

/** Zero-value Usage for the placeholder AssistantMessage returned by the proxy streamFn. */
const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Hooks the caller wires into the shared proxy streamFn to observe each LLM call. */
export interface ProxyStreamHooks {
	/** Concatenated text of each assistant response ('' when the turn produced no text). */
	onResponseText?: (text: string) => void;
	/**
	 * Invoked when the proxied LLM call REJECTS. The streamFn still pushes an assistant message
	 * with stopReason 'error' (which ends the pi-agent loop WITHOUT throwing out of
	 * prompt()/waitForIdle()), so the caller MUST record the error here and re-check it after
	 * waitForIdle() to fail the turn — otherwise a failed LLM call is swallowed as an empty
	 * "successful" completion.
	 */
	onError?: (err: Error) => void;
}

/**
 * Build the pi-agent StreamFn that routes every LLM call through the host proxy.
 *
 * Shared by agent-runner (chat) and workflow-runner (per step) so the content-block →
 * AssistantMessage mapping and — crucially — the error-capture path are byte-for-byte identical.
 * The `api` field must match what the host uses (via resolveProviderApi) or pi-ai serialises
 * tool-call history incorrectly on the turn after a tool execution for non-OpenAI providers.
 */
export function createProxyStreamFn(
	deps: { config: AgentRuntimeConfig; proxyClient: ProxyClient; fallbackSystemPrompt?: string },
	hooks: ProxyStreamHooks = {},
): StreamFn {
	const { config, proxyClient, fallbackSystemPrompt } = deps;
	const resolvedApi = resolveProviderApi(config.modelProvider ?? '');

	return (_model, context, options) => {
		const ctx = context as Context;
		const request: LlmProxyRequest = {
			messages: ctx.messages,
			systemPrompt: ctx.systemPrompt ?? fallbackSystemPrompt ?? config.systemInstruction,
			tools: ctx.tools,
			thinkingLevel: options?.reasoning,
		};

		logger.debug(
			{ messages: ctx.messages.length, tools: (ctx.tools ?? []).length },
			'[llm-stream] → LLM stream request',
		);

		const eventStream = createAssistantMessageEventStream();

		proxyClient
			.llmStream(request)
			.then(({ content: contentBlocks, stopReason }) => {
				const text = contentBlocks
					.filter((b) => b.type === 'text')
					.map((b) => (b as TextContent).text)
					.join('\n');
				hooks.onResponseText?.(text);

				logger.debug(
					{
						contentBlocks: contentBlocks.length,
						toolCalls: contentBlocks.filter((b) => b.type === 'toolCall').length,
						hasText: text.trim().length > 0,
						stopReason,
					},
					'[llm-stream] ← LLM stream response',
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

				// Hard guard against truncated tool calls: a completion cut off at the
				// output-token limit ('length') that still contains tool calls has almost
				// certainly had its arguments sliced mid-JSON — pi-ai's streaming parser
				// silently drops the incomplete field (e.g. run_code arriving as just
				// {"language":"python"}). Executing that partial call yields a misleading
				// "missing required property" error the model cannot fix (it has no control
				// over the cap), so it retries and truncates identically — an infinite loop.
				// Fail the turn legibly instead. A 'length' stop with NO tool calls is a
				// normal long text answer and is kept as-is.
				const hasToolCalls = content.some((b) => b.type === 'toolCall');
				if (stopReason === 'length' && hasToolCalls) {
					const err = new Error(
						'LLM response was truncated at the output-token limit before the tool call ' +
							'completed, so the tool was not executed. Increase the model’s max output ' +
							'tokens or request a shorter response.',
					);
					hooks.onError?.(err);
					const truncatedMessage: AssistantMessage = {
						role: 'assistant',
						content,
						api: resolvedApi as AssistantMessage['api'],
						provider: config.modelProvider || 'proxy',
						model: config.modelId || 'proxy',
						usage: zeroUsage,
						stopReason: 'error',
						errorMessage: err.message,
						timestamp: Date.now(),
					};
					eventStream.push({ type: 'error', reason: 'error', error: truncatedMessage });
					eventStream.end(truncatedMessage);
					return;
				}

				// A successful (non-error/aborted) stream ends with stop | length | toolUse —
				// the only reasons the 'done' event accepts. Anything else maps to 'stop'.
				const doneReason: 'length' | 'stop' | 'toolUse' =
					stopReason === 'length' ? 'length' : stopReason === 'toolUse' ? 'toolUse' : 'stop';
				const assistantMessage: AssistantMessage = {
					role: 'assistant',
					content,
					api: resolvedApi as AssistantMessage['api'],
					provider: config.modelProvider || 'proxy',
					model: config.modelId || 'proxy',
					usage: zeroUsage,
					stopReason: doneReason,
					timestamp: Date.now(),
				};

				eventStream.push({ type: 'done', reason: doneReason, message: assistantMessage });
				eventStream.end(assistantMessage);
			})
			.catch((err: Error) => {
				logger.error({ err }, '[llm-stream] LLM stream error');
				hooks.onError?.(err);
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
}

/**
 * Force exactly one more assistant turn to produce a concluding text, then return whatever text
 * the turn yielded (read from the caller's captured closure). Used when the tool loop went idle
 * without a final message: prompt() appends a user message — satisfying pi-agent's
 * last-message-must-be-user/toolResult rule — and starts one fresh turn.
 *
 * This does NOT decide whether an empty result is fatal — that stays with the caller (chat and
 * schema-step semantics differ). The caller is also responsible for the fire-at-most-once guard.
 */
export async function forceTextConclusion(
	agent: Agent,
	opts: { directive: string; getText: () => string },
): Promise<string> {
	await agent.prompt(opts.directive);
	await agent.waitForIdle();
	return opts.getText();
}
