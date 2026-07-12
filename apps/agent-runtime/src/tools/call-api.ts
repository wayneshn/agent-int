import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import type { ProxyMultipartPart, ProxyRequest } from '@repo/types';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, basename } from 'path';
import { logger } from '@repo/utils';
import { resolveWorkspacePath } from './types.js';
import type { ToolContext } from './types.js';

/** Maximum allowed TEXT body size in bytes — 1 MB. Overridable via ToolContext. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
/**
 * Maximum allowed BINARY payload in bytes (bodyFile / multipart files / responseFile) — 25 MB.
 * Base64 inflates ~1.33×, so this stays well under the 64 MB internal proxy JSON limit.
 * Overridable via ToolContext.
 */
const DEFAULT_MAX_BINARY_BYTES = 25 * 1_048_576;

/** Return a single text-content tool result (used for both success and error text). */
function textResult(text: string) {
	const textContent: TextContent = { type: 'text', text };
	return { content: [textContent], details: {} };
}

/**
 * call_api — Make an HTTP request to an external service.
 *
 * credentialId is OPTIONAL:
 *   - For authenticated APIs: provide the correct credentialId from the
 *     Available Credentials list. The host will inject the auth headers.
 *   - For public APIs that need no authentication: pass an empty string ""
 *     as credentialId. The request will be forwarded without any credential
 *     injection.
 *
 * Bodies come in three mutually exclusive forms:
 *   - `body`      — a text/JSON string.
 *   - `bodyFile`  — a workspace file sent as the raw binary request body
 *                   (set Content-Type via `headers`, e.g. application/pdf).
 *   - `multipart` — multipart/form-data parts (text fields and/or workspace files);
 *                   the host sets the Content-Type boundary automatically.
 * `responseFile` saves a binary response to a workspace file instead of returning it
 * as text. Binary bytes never pass through the model — files are referenced by path.
 *
 * IMPORTANT: Never attach a credential to a request unless you are certain
 * that credential belongs to the target service. Using a mismatched credential
 * risks leaking secrets to unintended third-party services.
 */
export function createCallApiTool(ctx: ToolContext): AgentTool {
	const maxBodyBytes = ctx.callApiMaxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const maxBinaryBytes = ctx.callApiMaxBinaryBytes ?? DEFAULT_MAX_BINARY_BYTES;

	const tool: AgentTool = {
		name: 'call_api',
		label: 'Call External API',
		description:
			'Make an HTTP request to an external URL. ' +
			'For authenticated APIs: provide the correct credentialId from the Available Credentials list — ' +
			'the host will inject the correct auth headers automatically. ' +
			'For public APIs that require NO authentication (e.g. open data endpoints): ' +
			'pass an empty string "" as credentialId. ' +
			'Request body (choose at most ONE): "body" for text/JSON; "bodyFile" (a workspace file path) ' +
			'to send a file as the raw binary body — set its Content-Type via headers (e.g. application/pdf); ' +
			'or "multipart" for multipart/form-data uploads — an array of parts where each part has a "name" ' +
			'and either a "value" (text field) or a "file" (workspace file path); do NOT set Content-Type for multipart. ' +
			'To download binary (PDF, image, zip), set "responseFile" to a workspace path and the response bytes ' +
			'are saved there instead of returned as text. ' +
			'IMPORTANT: Never use a credential for a service it does not belong to. ' +
			'Using a mismatched credential risks leaking secrets to third-party services.',
		parameters: Type.Object({
			credentialId: Type.Optional(
				Type.String({
					description:
						'ID of the credential to use for authenticated APIs. ' +
						'Omit or leave empty for public APIs that need no authentication.',
				}),
			),
			method: Type.Union([
				Type.Literal('GET'),
				Type.Literal('POST'),
				Type.Literal('PUT'),
				Type.Literal('DELETE'),
				Type.Literal('PATCH'),
			]),
			url: Type.String({ description: 'Full URL' }),
			headers: Type.Optional(Type.Record(Type.String(), Type.String())),
			qs: Type.Optional(Type.Record(Type.String(), Type.String())),
			body: Type.Optional(Type.String({ description: 'Text/JSON request body string (max 1 MB)' })),
			bodyFile: Type.Optional(
				Type.String({
					description:
						'Workspace file path to send as the raw binary request body. ' +
						'Set the Content-Type header appropriately. Mutually exclusive with body/multipart.',
				}),
			),
			multipart: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: 'Form field name' }),
						value: Type.Optional(Type.String({ description: 'Text field value' })),
						file: Type.Optional(
							Type.String({ description: 'Workspace file path for a file part' }),
						),
						filename: Type.Optional(
							Type.String({ description: 'File name (defaults to the file basename)' }),
						),
						contentType: Type.Optional(
							Type.String({ description: 'MIME type of the file part' }),
						),
					}),
					{
						description:
							'multipart/form-data parts. Each part has a name and either a value (text) or a file (workspace path).',
					},
				),
			),
			responseFile: Type.Optional(
				Type.String({
					description:
						'Workspace path to save a binary response to. When set, the response bytes are written ' +
						'to this file and only a short summary is returned (not the bytes).',
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			const p = params as {
				credentialId?: string;
				method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
				url: string;
				headers?: Record<string, string>;
				qs?: Record<string, string>;
				body?: string;
				bodyFile?: string;
				multipart?: Array<{
					name: string;
					value?: string;
					file?: string;
					filename?: string;
					contentType?: string;
				}>;
				responseFile?: string;
			};

			// At most one body source may be provided.
			const bodySources = [
				p.body != null && p.body !== '',
				!!p.bodyFile,
				!!(p.multipart && p.multipart.length > 0),
			].filter(Boolean).length;
			if (bodySources > 1) {
				return textResult(
					'Error: provide at most one of body, bodyFile, or multipart — they are mutually exclusive.',
				);
			}

			// Build the request incrementally so binary sources set the right encoding.
			const request: ProxyRequest = {
				credentialId: p.credentialId ?? '',
				method: p.method,
				url: p.url,
				headers: p.headers,
				qs: p.qs,
			};

			try {
				if (p.bodyFile) {
					// Raw binary upload: read the workspace file and send it base64-encoded.
					const resolved = resolveWorkspacePath(ctx.workspaceRoot, p.bodyFile);
					const bytes = readFileSync(resolved);
					if (bytes.byteLength > maxBinaryBytes) {
						return textResult(
							`Error: ${p.bodyFile} is ${bytes.byteLength} bytes, exceeding the maximum of ${maxBinaryBytes} bytes.`,
						);
					}
					request.body = bytes.toString('base64');
					request.bodyEncoding = 'base64';
				} else if (p.multipart && p.multipart.length > 0) {
					// Multipart upload: read any file parts, base64-encode, enforce a total cap.
					let totalBytes = 0;
					const parts: ProxyMultipartPart[] = [];
					for (const part of p.multipart) {
						if (part.file) {
							const resolved = resolveWorkspacePath(ctx.workspaceRoot, part.file);
							const bytes = readFileSync(resolved);
							totalBytes += bytes.byteLength;
							if (totalBytes > maxBinaryBytes) {
								return textResult(
									`Error: multipart files total more than the maximum of ${maxBinaryBytes} bytes.`,
								);
							}
							parts.push({
								name: part.name,
								dataBase64: bytes.toString('base64'),
								filename: part.filename ?? basename(part.file),
								contentType: part.contentType ?? 'application/octet-stream',
							});
						} else {
							parts.push({ name: part.name, value: part.value ?? '' });
						}
					}
					request.multipart = parts;
				} else if (p.body) {
					// Text body — enforce the UTF-8 text cap as before.
					if (Buffer.byteLength(p.body, 'utf-8') > maxBodyBytes) {
						return textResult(
							`Error: call_api body exceeds maximum allowed size (${maxBodyBytes} bytes)`,
						);
					}
					request.body = p.body;
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return textResult(`Error reading upload file: ${message}`);
			}

			if (p.responseFile) {
				request.responseEncoding = 'base64';
			}

			logger.debug(
				{
					credentialId: request.credentialId || '(none)',
					method: p.method,
					url: p.url,
					mode: p.bodyFile ? 'bodyFile' : p.multipart ? 'multipart' : 'body',
					responseFile: p.responseFile ?? undefined,
				},
				'[agent-runner] call_api executing',
			);

			const response = await ctx.proxyClient.proxy(request);

			logger.debug({ status: response.status }, '[agent-runner] call_api response');

			// Binary download: write the bytes to the workspace, return only a summary.
			if (p.responseFile && response.bodyEncoding === 'base64') {
				try {
					const bytes = Buffer.from(response.body, 'base64');
					if (bytes.byteLength > maxBinaryBytes) {
						return textResult(
							`Error: response is ${bytes.byteLength} bytes, exceeding the maximum of ${maxBinaryBytes} bytes.`,
						);
					}
					const resolved = resolveWorkspacePath(ctx.workspaceRoot, p.responseFile);
					mkdirSync(dirname(resolved), { recursive: true });
					writeFileSync(resolved, bytes);
					return textResult(
						`HTTP ${response.status} — saved ${bytes.byteLength} bytes to ${p.responseFile}`,
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return textResult(`HTTP ${response.status}, but failed to save response file: ${message}`);
				}
			}

			return textResult(`HTTP ${response.status}\n${response.body}`);
		},
	};

	return tool;
}
