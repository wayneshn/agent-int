// @repo/utils — shared utility functions (Node.js only — uses node:fs)
export { logger } from './logger.js';

export { resolveProviderApi, PROVIDER_TO_PI_API } from './llm-provider-api-map.js';

export { EMAIL_REGEX, normalizeEmail, isValidEmail } from './validation.js';

export { extractJsonValue } from './json-extract.js';

export {
	loadCredentialDefinitions,
	getCredentialDefinition,
	clearDefinitionsCache,
} from './integrations/registry.js';

export { credentialDefinitionSchema } from './integrations/schema.js';

export {
	loadSkillCatalog,
	getSkillInstructions,
	getSkillCatalogEntry,
	getSkillRawFile,
	getSkillBundleFiles,
	parseSkillMarkdown,
	replaceSkillMarkdownBody,
	clearSkillCatalogCache,
} from './skills/registry.js';
export type { SkillBundleFile, ParsedSkillMarkdown } from './skills/registry.js';

export { validateWorkflowCreate, validateWorkflowUpdate } from './workflow/validator.js';
export type { ValidatedWorkflowCreate, ValidatedWorkflowUpdate } from './workflow/validator.js';

export {
	stepsToGraph,
	graphToSteps,
	ensureGraph,
	specToGraph,
	hasCycle,
	isLoopBackEdge,
	TRIGGER_NODE_ID,
} from './workflow/graph.js';

export { evalFilter, isUnaryOperator } from './workflow/filter.js';
export type { TemplateResolver } from './workflow/filter.js';

export {
	BROWSER_TOOL_GROUP,
	WORKFLOW_TOOL_CATALOG,
	WORKFLOW_TOOL_CATEGORIES,
} from './workflow/tool-catalog.js';
