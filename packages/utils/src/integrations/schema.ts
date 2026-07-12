import { z } from 'zod';

/** Zod schema for validating credential YAML definitions at load time */

const credentialTypeSchema = z.enum([
	'apiKey',
	'basicAuth',
	'bearerToken',
	'oauth2',
	'oauth1',
	'custom',
]);

const propertyTypeSchema = z.enum(['string', 'secret', 'number', 'boolean', 'options']);

const credentialPropertyOptionSchema = z.object({
	name: z.string(),
	value: z.union([z.string(), z.number()]),
});

const credentialPropertySchema = z.object({
	name: z.string(),
	displayName: z.string(),
	type: propertyTypeSchema,
	required: z.boolean(),
	default: z.union([z.string(), z.number(), z.boolean()]).optional(),
	description: z.string().optional(),
	options: z.array(credentialPropertyOptionSchema).optional(),
});

const requestMappingSchema = z.object({
	headers: z.record(z.string(), z.string()).optional(),
	qs: z.record(z.string(), z.string()).optional(),
	body: z.record(z.string(), z.string()).optional(),
});

const oauth2ConfigSchema = z.object({
	authorizationUrl: z.string().url(),
	accessTokenUrl: z.string().url(),
	revokeUrl: z.string().url().optional(),
	clientIdProperty: z.string().optional(),
	clientSecretProperty: z.string().optional(),
	scope: z.string().optional(),
	authStyle: z.enum(['inHeader', 'inBody']).optional(),
	/** Defaults to authorizationCode when omitted */
	grantType: z.enum(['authorizationCode', 'clientCredentials']).optional(),
	/** When true, PKCE S256 challenge is used instead of client_secret */
	usePkce: z.boolean().optional(),
	/**
	 * Additional query parameters appended to the authorization URL.
	 * Use this for provider-specific params (e.g. Google's access_type=offline,
	 * prompt=consent) that should NOT be sent to every provider.
	 */
	extraAuthParams: z.record(z.string(), z.string()).optional(),
});

const scaConfigSchema = z.object({
	/**
	 * Name of the (secret) property holding the PEM-encoded RSA private key used to
	 * sign the strong-customer-authentication challenge.
	 */
	privateKeyProperty: z.string(),
	/**
	 * Response header carrying the one-time challenge token on a 403. Defaults to
	 * 'x-2fa-approval' (Wise). The value is signed and echoed back on retry.
	 */
	approvalHeader: z.string().optional(),
	/** Request header the signature is sent in on retry. Defaults to 'x-signature'. */
	signatureHeader: z.string().optional(),
	/** Node crypto signing algorithm. Defaults to 'RSA-SHA256'. */
	algorithm: z.string().optional(),
});

const testRequestSchema = z.object({
	method: z.enum(['GET', 'POST']),
	/**
	 * The URL to send the test request to. Supports {{properties.keyName}} interpolation,
	 * so integrations like Home Assistant can use dynamic host/port values from credential data.
	 * Validated as a plain string (not URL) to allow template expressions.
	 */
	url: z.string().min(1),
	/**
	 * Optional HTTP headers to include with the test request.
	 * Use this for APIs that require a specific Content-Type or other headers
	 * that are not injected by the credential's requestMapping.
	 * Example: { 'Content-Type': 'application/json' }
	 */
	headers: z.record(z.string(), z.string()).optional(),
	/**
	 * Optional request body string sent with POST test requests.
	 * Required for APIs that are POST-only, such as GraphQL endpoints.
	 * Example: '{"query":"{ account { id email } }"}'
	 */
	body: z.string().optional(),
	/**
	 * Dot-notation key path into the JSON response body whose value will be
	 * stored as `connectedAccount` on the credential after a successful OAuth2
	 * authorization. Only used during the OAuth2 callback flow.
	 * Example: "email"  →  response.email
	 *          "data.user.login"  →  response.data.user.login
	 */
	accountIdentifierKey: z.string().optional(),
});

export const credentialDefinitionSchema = z.object({
	id: z.string(),
	name: z.string(),
	brandName: z.string(),
	type: credentialTypeSchema,
	icon: z.string().optional(),
	description: z.string().optional(),
	documentationUrl: z.string().url().optional(),
	properties: z.array(credentialPropertySchema),
	requestMapping: requestMappingSchema.optional(),
	oauth2: oauth2ConfigSchema.optional(),
	/**
	 * Strong Customer Authentication — enables a signed 403-challenge retry.
	 * When present and the credential has a private key, a 403 carrying the
	 * approval header is retried with an RSA signature over the challenge token.
	 */
	sca: scaConfigSchema.optional(),
	testRequest: testRequestSchema.optional(),
});

export type ValidatedCredentialDefinition = z.infer<typeof credentialDefinitionSchema>;
