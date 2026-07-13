import type { AppTriggerProvider } from './AppTriggerProvider.js';
import { GmailTriggerProvider } from './providers/GmailTriggerProvider.js';
import { OutlookTriggerProvider } from './providers/OutlookTriggerProvider.js';
import { NotionTriggerProvider } from './providers/NotionTriggerProvider.js';
import { SlackTriggerProvider } from './providers/SlackTriggerProvider.js';
import { GoogleFormsTriggerProvider } from './providers/GoogleFormsTriggerProvider.js';

/**
 * Registry of app-trigger providers. Adding a future app = one AppTriggerProvider
 * implementation plus one entry in the constructor below. Mirrors
 * CloudProviderRegistry (services/knowledge/providerRegistry.ts).
 */
export class AppTriggerProviderRegistry {
	private providers: Map<string, AppTriggerProvider>;

	constructor() {
		const all: AppTriggerProvider[] = [
			new GmailTriggerProvider(),
			new OutlookTriggerProvider(),
			new NotionTriggerProvider(),
			new SlackTriggerProvider(),
			new GoogleFormsTriggerProvider(),
		];
		this.providers = new Map(all.map((provider) => [provider.id, provider]));
	}

	getAll(): AppTriggerProvider[] {
		return [...this.providers.values()];
	}

	getById(id: string): AppTriggerProvider | undefined {
		return this.providers.get(id);
	}

	/** True when a credential's definition id is accepted by the provider. */
	isCompatible(provider: AppTriggerProvider, credentialType: string): boolean {
		return provider.compatibleCredentialTypes.includes(credentialType);
	}
}
