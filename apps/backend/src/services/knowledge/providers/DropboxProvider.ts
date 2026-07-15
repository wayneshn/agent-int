import type { CloudFileEntry, CloudFileListResult } from '@repo/types';
import type { CredentialResolverService } from '../../CredentialResolverService.js';
import {
	readErrorExcerpt,
	type CloudDownloadResult,
	type CloudFileRef,
	type CloudListOptions,
	type CloudProviderContext,
	type CloudStorageProvider,
} from '../CloudStorageProvider.js';

const API_BASE = 'https://api.dropboxapi.com/2';
const CONTENT_BASE = 'https://content.dropboxapi.com/2';
const PAGE_SIZE = 50;

interface DropboxEntry {
	'.tag': 'file' | 'folder' | 'deleted';
	name: string;
	path_lower?: string;
	path_display?: string;
	size?: number;
	server_modified?: string;
}

interface DropboxListFolderResponse {
	entries: DropboxEntry[];
	cursor: string;
	has_more: boolean;
}

interface DropboxSearchMatch {
	metadata: { '.tag': string; metadata: DropboxEntry };
}

interface DropboxSearchResponse {
	matches: DropboxSearchMatch[];
	cursor?: string;
	has_more: boolean;
}

/**
 * The Dropbox-API-Arg header must be ASCII — escape any non-ASCII characters
 * (e.g. in file paths) as \uXXXX sequences per Dropbox's HTTP header rules.
 */
function asciiSafeJson(value: Record<string, string>): string {
	return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => {
		return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
	});
}

function toCloudEntry(entry: DropboxEntry): CloudFileEntry | undefined {
	if (entry['.tag'] === 'deleted' || !entry.path_lower) return undefined;
	return {
		externalId: entry.path_lower,
		name: entry.name,
		kind: entry['.tag'] === 'folder' ? 'folder' : 'file',
		sizeBytes: entry.size,
		modifiedAt: entry.server_modified,
		path: entry.path_display,
	};
}

export class DropboxProvider implements CloudStorageProvider {
	readonly id = 'dropbox';
	readonly displayName = 'Dropbox';
	readonly icon = '/logos/dropbox.svg';
	readonly compatibleCredentialTypes = ['dropbox-access-token', 'dropbox-oauth2'];

	private resolver: CredentialResolverService;

	constructor(resolver: CredentialResolverService) {
		this.resolver = resolver;
	}

	private async rpc(ctx: CloudProviderContext, path: string, body: object): Promise<Response> {
		return this.resolver.executeWithCredential(ctx.credentialId, ctx.ownerId, {
			url: `${API_BASE}${path}`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	async list(ctx: CloudProviderContext, options: CloudListOptions): Promise<CloudFileListResult> {
		// Search and folder listing have separate cursor-continue endpoints; the
		// active mode is implied by whether `search` is set alongside the token.
		if (options.search) {
			const response = options.pageToken
				? await this.rpc(ctx, '/files/search/continue_v2', { cursor: options.pageToken })
				: await this.rpc(ctx, '/files/search_v2', {
						query: options.search,
						options: { max_results: PAGE_SIZE, file_status: 'active' },
					});
			if (!response.ok) {
				throw new Error(
					`Dropbox search failed (${response.status}): ${await readErrorExcerpt(response)}`,
				);
			}
			const body = (await response.json()) as DropboxSearchResponse;
			const entries = body.matches
				.map((match) => toCloudEntry(match.metadata.metadata))
				.filter((entry): entry is CloudFileEntry => entry !== undefined);
			return { entries, nextPageToken: body.has_more ? body.cursor : undefined };
		}

		const response = options.pageToken
			? await this.rpc(ctx, '/files/list_folder/continue', { cursor: options.pageToken })
			: await this.rpc(ctx, '/files/list_folder', {
					path: options.folderId ?? '',
					limit: PAGE_SIZE,
				});
		if (!response.ok) {
			throw new Error(
				`Dropbox list failed (${response.status}): ${await readErrorExcerpt(response)}`,
			);
		}
		const body = (await response.json()) as DropboxListFolderResponse;
		const entries = body.entries
			.map(toCloudEntry)
			.filter((entry): entry is CloudFileEntry => entry !== undefined);
		return { entries, nextPageToken: body.has_more ? body.cursor : undefined };
	}

	async download(ctx: CloudProviderContext, file: CloudFileRef): Promise<CloudDownloadResult> {
		// Content endpoints take args in the Dropbox-API-Arg header, not the body
		const response = await this.resolver.executeWithCredential(ctx.credentialId, ctx.ownerId, {
			url: `${CONTENT_BASE}/files/download`,
			method: 'POST',
			headers: { 'Dropbox-API-Arg': asciiSafeJson({ path: file.externalId }) },
		});
		if (!response.ok) {
			throw new Error(
				`Dropbox download failed (${response.status}): ${await readErrorExcerpt(response)}`,
			);
		}
		return {
			data: Buffer.from(await response.arrayBuffer()),
			name: file.name,
			mimeType: file.mimeType ?? response.headers.get('content-type') ?? 'application/octet-stream',
		};
	}
}
