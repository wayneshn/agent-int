import type { Model } from '@earendil-works/pi-ai';
import { resolveProviderApi } from '@repo/utils';
import { findCatalogModel, getCatalogProviders } from './modelCatalog.js';
import { AgentService } from '../AgentService.js';
import { LlmProviderService } from '../LlmProviderService.js';
import { logger } from '../../config/logger.js';

/** A pi-ai Model plus its decrypted API key (kept separate — never stored on the model) */
export interface ResolvedAgentModel {
	model: Model<string>;
	apiKey: string;
}

/**
 * Resolve the pi-ai Model and decrypted API key for an agent's chat model.
 * Shared by AgentLlmProxyService (runtime LLM proxy) and SkillEvolutionService
 * (background reflection calls) so provider/API mapping and catalog pricing
 * resolution stay consistent.
 *
 * The apiKey is returned separately — never stored on the model object — to
 * make it clear that it must be passed explicitly to stream()/complete() options.
 */
export async function resolveAgentModel(
	agentService: AgentService,
	llmProviderService: LlmProviderService,
	agentId: string,
	ownerId: string,
): Promise<ResolvedAgentModel> {
	const agent = await agentService.getById(agentId, ownerId);
	if (!agent) {
		throw new Error(`Agent not found: ${agentId}`);
	}
	if (!agent.modelConfigId) {
		throw new Error(`Agent ${agentId} has no model configured`);
	}

	const config = await llmProviderService.getById(agent.modelConfigId, ownerId);
	if (!config) {
		throw new Error(`LLM config not found: ${agent.modelConfigId}`);
	}

	const secretData = await llmProviderService.getDecryptedData(agent.modelConfigId, ownerId);
	if (!secretData) {
		throw new Error(`Could not decrypt LLM config for agent ${agentId}`);
	}

	logger.debug(
		{ agentId, provider: config.provider, model: config.model },
		'[llm] resolved model config',
	);

	// Map the stored provider string to the pi-ai API identifier using the shared
	// utility from @repo/utils. Centralising the map in one place ensures agent-runner
	// and the backend always agree on the api field of AssistantMessage.
	const api = resolveProviderApi(config.provider);

	// The stored model id IS the exact native id the provider/pi-ai API expects and
	// is passed through verbatim. Slashes are NOT special — aggregators (OpenRouter,
	// NVIDIA) legitimately use "vendor/model" ids and Bedrock uses dotted ids.
	const nativeModelId = config.model;

	// Look up catalog pricing, context window, modalities, and reasoning for accurate
	// cost tracking. Matches on the compound (provider, model).
	const catalogEntry = findCatalogModel(config.provider, config.model);

	// IMPORTANT: The catalog stores pricing as cost-per-single-token (e.g. 0.000003).
	// pi-ai expects cost-per-MILLION-tokens (e.g. 3.0).
	// Multiply by 1_000_000 to convert.
	const perMillion = (raw: string | undefined): number => {
		if (!raw) return 0;
		const v = parseFloat(raw);
		return isNaN(v) ? 0 : v * 1_000_000;
	};
	const contextWindow = catalogEntry?.contextLength ?? 128000;

	// Max OUTPUT tokens. Derived from the catalog's real per-model limit
	// (topProvider.maxCompletionTokens, e.g. 64000 for Sonnet) — NOT a fixed 4096,
	// which starved reasoning models: Anthropic's max_tokens includes the thinking
	// budget, so a 4096 cap left ~1024 tokens for the answer + tool call and truncated
	// tool-call arguments mid-JSON. This is a ceiling, not a reservation — the model
	// still stops when done. Fall back to a generous default when the catalog is unsure.
	const maxOutputTokens = catalogEntry?.topProvider?.maxCompletionTokens ?? 8192;

	// Declare the model's real input modalities so vision models actually receive
	// image content blocks (e.g. browser screenshots in tool results). Previously
	// hardcoded to ['text'], which made pi-ai strip every image before the request.
	// pi-ai's Model.input only accepts 'text'|'image', so map the catalog's broader
	// modality list down to those and always keep 'text'.
	const inputModalities = (catalogEntry?.architecture?.inputModalities ?? ['text']).filter(
		(m): m is 'text' | 'image' => m === 'text' || m === 'image',
	);
	const modelInput: ('text' | 'image')[] = inputModalities.includes('text')
		? inputModalities
		: ['text', ...inputModalities];

	const model: Model<string> = {
		id: nativeModelId,
		api,
		provider: config.provider,
		name: config.model,
		reasoning: catalogEntry?.reasoning ?? false,
		input: modelInput,
		cost: {
			input: perMillion(catalogEntry?.pricing.promptPerToken),
			output: perMillion(catalogEntry?.pricing.completionPerToken),
			cacheRead: perMillion(catalogEntry?.pricing.cacheReadPerToken),
			cacheWrite: perMillion(catalogEntry?.pricing.cacheWritePerToken),
		},
		contextWindow,
		maxTokens: maxOutputTokens,
		// Prefer a user-supplied baseUrl; otherwise fall back to the provider's fixed
		// default (e.g. OpenRouter / NVIDIA) so those work with just an API key.
		baseUrl:
			secretData.baseUrl?.trim() ||
			getCatalogProviders().find((p) => p.id === config.provider)?.defaultBaseUrl ||
			'',
	};

	return { model, apiKey: secretData.apiKey };
}

/**
 * Build the pi-ai auth options for a resolved model.
 *
 * Bedrock's `bedrock-converse-stream` API ignores `options.apiKey` entirely — it
 * authenticates from `options.bearerToken` (an AWS Bedrock API key) or the AWS SDK
 * default credential chain. So for amazon-bedrock we route the stored key to
 * `bearerToken`; without this a user-supplied Bedrock API key is dropped and the
 * SDK throws "Could not load credentials from any providers". All other providers
 * use `apiKey`.
 */
export function buildProviderAuthOptions(
	model: Model<string>,
	apiKey: string,
): Record<string, unknown> {
	if (model.provider.toLowerCase() === 'amazon-bedrock') {
		return { bearerToken: apiKey };
	}
	return { apiKey };
}
