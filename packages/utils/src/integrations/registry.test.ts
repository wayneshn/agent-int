import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { credentialDefinitionSchema } from './schema.js';
import { loadCredentialDefinitions, getCredentialDefinition, clearDefinitionsCache } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFINITIONS_DIR = path.resolve(__dirname, 'definitions');

function definitionFiles(): string[] {
	return fs.readdirSync(DEFINITIONS_DIR).filter((f) => f.endsWith('.yaml'));
}

describe('credential definition YAML files', () => {
	it('every .yaml file is schema-valid (the registry must not silently drop any)', () => {
		const files = definitionFiles();
		expect(files.length).toBeGreaterThan(50); // the catalog claims 100+ integrations

		const invalid: string[] = [];
		for (const file of files) {
			const parsed = yaml.load(fs.readFileSync(path.join(DEFINITIONS_DIR, file), 'utf-8'));
			const result = credentialDefinitionSchema.safeParse(parsed);
			if (!result.success) invalid.push(file);
		}
		expect(invalid).toEqual([]);
	});

	it('definition ids are unique', () => {
		const ids = definitionFiles().map((file) => {
			const parsed = yaml.load(fs.readFileSync(path.join(DEFINITIONS_DIR, file), 'utf-8')) as {
				id: string;
			};
			return parsed.id;
		});
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('oauth2 definitions declare a testRequest (needed for the connection test flow)', () => {
		// Not a hard invariant — informational guard against catalog regressions.
		const files = definitionFiles();
		const oauth2WithoutTest: string[] = [];
		for (const file of files) {
			const parsed = yaml.load(fs.readFileSync(path.join(DEFINITIONS_DIR, file), 'utf-8')) as {
				type: string;
				testRequest?: unknown;
			};
			if (parsed.type === 'oauth2' && !parsed.testRequest) oauth2WithoutTest.push(file);
		}
		// If a provider legitimately cannot support a test request, list it here explicitly.
		const knownExceptions: string[] = [];
		expect(oauth2WithoutTest.filter((f) => !knownExceptions.includes(f))).toEqual([]);
	});
});

describe('registry loading', () => {
	it('loads every definition file (no silent drops)', () => {
		clearDefinitionsCache();
		const defs = loadCredentialDefinitions();
		expect(defs.length).toBe(definitionFiles().length);
	});

	it('getCredentialDefinition round-trips by id', () => {
		clearDefinitionsCache();
		const defs = loadCredentialDefinitions();
		const sample = defs.find((d) => d.id === 'slack') ?? defs[0];
		expect(getCredentialDefinition(sample.id)).toEqual(sample);
		expect(getCredentialDefinition('definitely-not-a-real-id')).toBeUndefined();
	});

	it('caches after first load', () => {
		clearDefinitionsCache();
		const first = loadCredentialDefinitions();
		const second = loadCredentialDefinitions();
		expect(second).toBe(first); // same array reference
	});
});
