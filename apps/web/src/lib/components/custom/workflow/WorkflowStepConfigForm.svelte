<script lang="ts">
	import * as Select from '$lib/components/ui/select/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import type {
		WorkflowStep,
		CredentialMetadata,
		CredentialDefinition,
		WorkflowToolCatalog
	} from '@repo/types';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import GlobeIcon from '@lucide/svelte/icons/globe';

	/**
	 * The full set of editable fields for a single workflow agent step, rendered by
	 * the visual builder's node-config Sheet. Emits the updated step on every change
	 * via `onChange`.
	 */

	// Variable hints shown in placeholder/help text — stored as const to avoid
	// Svelte template parser treating {{ as a Svelte expression.
	const VAR_TRIGGER = '{{trigger.payload}}';
	const VAR_STEP_ID = '{{steps.<nodeId>.output}}';
	const VAR_STEP_FIELD = '{{steps.<nodeId>.output.field}}';
	const VAR_STEP_INDEX = '{{steps.0.output}}';
	const VAR_LOOP_ITEM = '{{loop.item}}';
	const VAR_LOOP_INDEX = '{{loop.index}}';
	const SCHEMA_PLACEHOLDER =
		'{\n  "type": "object",\n  "properties": {\n    "result": { "type": "string" }\n  }\n}';

	interface Props {
		step: WorkflowStep;
		credentials: CredentialMetadata[];
		/** Credential definitions used to resolve integration icons */
		definitions: CredentialDefinition[];
		/** When true, show the "Agent Browser" tool group (agent has browser access). */
		browserAvailable?: boolean;
		/** Tool-picker catalog (values live in @repo/utils, passed from the server load). */
		toolCatalog: WorkflowToolCatalog;
		onChange: (updated: WorkflowStep) => void;
	}

	let {
		step,
		credentials,
		definitions,
		browserAvailable = false,
		toolCatalog,
		onChange
	}: Props = $props();

	/** Selectable individual tools, grouped by category for the picker sections. */
	const TOOL_GROUPS = $derived(
		toolCatalog.categories.map((category) => ({
			category,
			tools: toolCatalog.catalog.filter((t) => t.category === category)
		}))
	);

	function getDefinition(type: string): CredentialDefinition | undefined {
		return definitions.find((d) => d.id === type);
	}

	// ── Local editable copies ─────────────────────────────────────────────────
	let name = $state(step.name);
	let instruction = $state(step.instruction);
	let inputMapping = $state(step.inputMapping ?? '');
	let maxToolCallsPerStep = $state(step.maxToolCallsPerStep ?? 20);
	let expectedResponseSchema = $state(
		step.expectedResponseSchema ? JSON.stringify(step.expectedResponseSchema, null, 2) : ''
	);
	let schemaError = $state('');
	let errorAction = $state<'stop' | 'continue' | 'retry'>(step.errorHandling.action);
	let maxRetries = $state(step.errorHandling.maxRetries ?? 3);
	let fallbackAction = $state<'stop' | 'continue'>(step.errorHandling.fallbackAction ?? 'stop');

	let selectedTools = $state<Set<string>>(new Set(step.allowedTools));
	let selectedCredentialIds = $state<Set<string>>(new Set(step.allowedCredentialIds));
	let useAllTools = $state(step.allTools ?? false);
	let useAllCredentials = $state(step.allCredentials ?? false);

	/** Emit updated step to parent */
	function emit() {
		let parsedSchema: Record<string, unknown> | undefined;
		schemaError = '';
		if (expectedResponseSchema.trim()) {
			try {
				parsedSchema = JSON.parse(expectedResponseSchema) as Record<string, unknown>;
			} catch {
				schemaError = 'Invalid JSON — schema will not be saved until fixed.';
				parsedSchema = undefined;
			}
		}

		onChange({
			...step,
			name,
			instruction,
			inputMapping: inputMapping.trim() || undefined,
			allowedTools: useAllTools ? [] : [...selectedTools],
			allTools: useAllTools,
			allowedCredentialIds: useAllCredentials ? [] : [...selectedCredentialIds],
			allCredentials: useAllCredentials,
			maxToolCallsPerStep,
			expectedResponseSchema: parsedSchema,
			errorHandling: {
				action: errorAction,
				...(errorAction === 'retry' ? { maxRetries, fallbackAction } : {})
			}
		});
	}

	function toggleTool(toolName: string) {
		const next = new Set(selectedTools);
		if (next.has(toolName)) next.delete(toolName);
		else next.add(toolName);
		selectedTools = next;
		emit();
	}

	function toggleCredential(id: string) {
		const next = new Set(selectedCredentialIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedCredentialIds = next;
		emit();
	}

	// Keep the selected subset intact while "use all" is on (the list is merely
	// hidden) so toggling off restores the user's prior selection instead of
	// silently widening the step to all tools/credentials. emit() already sends
	// an empty list when the flag is on.
	function setUseAllTools(v: boolean) {
		useAllTools = v;
		emit();
	}

	function setUseAllCredentials(v: boolean) {
		useAllCredentials = v;
		emit();
	}

	const errorActionLabel = $derived(
		errorAction === 'stop' ? 'Stop workflow' : errorAction === 'continue' ? 'Continue' : 'Retry'
	);

	const fallbackActionLabel = $derived(
		fallbackAction === 'stop' ? 'Stop workflow' : 'Continue to next step'
	);
</script>

<div class="space-y-4">
	<!-- Step name -->
	<div class="space-y-1.5">
		<Label for="step-name-{step.id}">Step name</Label>
		<Input
			id="step-name-{step.id}"
			type="text"
			bind:value={name}
			oninput={emit}
			placeholder="e.g. Fetch weather data"
			required
		/>
	</div>

	<!-- Instruction -->
	<div class="space-y-1.5">
		<Label for="step-instruction-{step.id}">Instruction</Label>
		<textarea
			id="step-instruction-{step.id}"
			bind:value={instruction}
			oninput={emit}
			placeholder="Describe what the agent should do in this step…"
			rows={4}
			class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
		></textarea>
	</div>

	<!-- Input mapping -->
	<div class="space-y-1.5">
		<Label for="step-input-{step.id}">
			Input mapping
			<span class="ml-1 font-normal text-muted-foreground">(optional)</span>
		</Label>
		<textarea
			id="step-input-{step.id}"
			bind:value={inputMapping}
			oninput={emit}
			placeholder="e.g. The trigger data is: {VAR_TRIGGER}"
			rows={2}
			class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
		></textarea>
		<p class="text-xs text-muted-foreground">
			Variables: <code class="rounded bg-muted px-1 py-0.5 text-xs">{VAR_TRIGGER}</code>,
			<code class="rounded bg-muted px-1 py-0.5 text-xs">{VAR_STEP_ID}</code>. Drill into fields
			with dot paths, e.g.
			<code class="rounded bg-muted px-1 py-0.5 text-xs">{VAR_STEP_FIELD}</code>
			(legacy <code class="rounded bg-muted px-1 py-0.5 text-xs">{VAR_STEP_INDEX}</code> also works).
			Inside a loop body use <code class="rounded bg-muted px-1 py-0.5 text-xs">{VAR_LOOP_ITEM}</code>
			/ <code class="rounded bg-muted px-1 py-0.5 text-xs">{VAR_LOOP_INDEX}</code> (these also work in
			the instruction above). Copy a node's “Output ref” from its panel. Leave empty and, inside a
			loop, the step auto-receives the current item; otherwise it gets the previous step's output.
		</p>
	</div>

	<!-- Allowed tools -->
	<div class="space-y-2">
		<Label>Allowed tools</Label>
		<div
			class="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2.5"
		>
			<div class="space-y-0.5">
				<p class="text-sm font-medium text-foreground">Use all tools</p>
				<p class="text-xs text-muted-foreground">Grant this step every tool the agent has.</p>
			</div>
			<Switch checked={useAllTools} onCheckedChange={setUseAllTools} />
		</div>
		{#if !useAllTools}
			<div class="space-y-3">
				{#each TOOL_GROUPS as group (group.category)}
					<div class="space-y-1.5">
						<p class="text-xs font-medium text-muted-foreground">{group.category}</p>
						<div class="grid grid-cols-2 gap-1.5">
							{#each group.tools as tool (tool.name)}
								{@const isSelected = selectedTools.has(tool.name)}
								<label
									class="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors {isSelected
										? 'border-primary bg-primary/5 text-foreground'
										: 'border-border text-muted-foreground hover:bg-muted/50'}"
								>
									<input
										type="checkbox"
										checked={isSelected}
										onchange={() => toggleTool(tool.name)}
										class="size-3 rounded border-border accent-primary"
									/>
									{tool.label}
								</label>
							{/each}
						</div>
					</div>
				{/each}

				{#if browserAvailable}
					{@const browserSelected = selectedTools.has(toolCatalog.browserToolGroup)}
					<div class="space-y-1.5">
						<p class="text-xs font-medium text-muted-foreground">Web / Browser</p>
						<label
							class="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors {browserSelected
								? 'border-primary bg-primary/5 text-foreground'
								: 'border-border text-muted-foreground hover:bg-muted/50'}"
						>
							<input
								type="checkbox"
								checked={browserSelected}
								onchange={() => toggleTool(toolCatalog.browserToolGroup)}
								class="size-3 rounded border-border accent-primary"
							/>
							<GlobeIcon class="size-3.5" />
							<span class="font-medium">Agent Browser</span>
							<span class="text-muted-foreground">— all browser tools</span>
						</label>
					</div>
				{/if}
			</div>
			<p class="text-xs text-muted-foreground">
				Leave all unchecked to allow all tools. Check specific tools to restrict this step.
			</p>
		{/if}
	</div>

	<!-- Allowed credentials -->
	{#if credentials.length > 0}
		<div class="space-y-2">
			<Label>Allowed credentials</Label>
			<div
				class="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2.5"
			>
				<div class="space-y-0.5">
					<p class="text-sm font-medium text-foreground">Use all credentials</p>
					<p class="text-xs text-muted-foreground">
						All credentials assigned to this agent, including ones added later.
					</p>
				</div>
				<Switch checked={useAllCredentials} onCheckedChange={setUseAllCredentials} />
			</div>
			{#if !useAllCredentials}
				<div class="space-y-1.5">
					{#each credentials as cred (cred.id)}
						{@const isSelected = selectedCredentialIds.has(cred.id)}
						{@const def = getDefinition(cred.type)}
						<label
							class="flex cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2 text-xs transition-colors {isSelected
								? 'border-primary bg-primary/5'
								: 'border-border hover:bg-muted/50'}"
						>
							<input
								type="checkbox"
								checked={isSelected}
								onchange={() => toggleCredential(cred.id)}
								class="size-3 rounded border-border accent-primary"
							/>
							<div
								class="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground"
							>
								{#if def?.icon}
									<img src={def.icon} alt={cred.type} class="size-3.5 object-contain" />
								{:else}
									<ShieldIcon class="size-3" />
								{/if}
							</div>
							<span class="truncate font-medium text-foreground">{cred.name}</span>
							<span class="ml-auto shrink-0 text-muted-foreground">{cred.type}</span>
						</label>
					{/each}
				</div>
				<p class="text-xs text-muted-foreground">
					Leave all unchecked to allow all agent credentials for this step.
				</p>
			{/if}
		</div>
	{/if}

	<!-- Max tool calls -->
	<div class="space-y-1.5">
		<Label for="step-max-tools-{step.id}">Max tool calls per step</Label>
		<Input
			id="step-max-tools-{step.id}"
			type="number"
			min={1}
			max={100}
			bind:value={maxToolCallsPerStep}
			oninput={emit}
			class="w-28"
		/>
		<p class="text-xs text-muted-foreground">
			Maximum tool calls the agent may make in this step (1–100). Default: 20.
		</p>
	</div>

	<!-- Expected response schema -->
	<div class="space-y-1.5">
		<Label for="step-schema-{step.id}">
			Expected response schema
			<span class="ml-1 font-normal text-muted-foreground">(optional JSON Schema)</span>
		</Label>
		<textarea
			id="step-schema-{step.id}"
			bind:value={expectedResponseSchema}
			oninput={emit}
			placeholder={SCHEMA_PLACEHOLDER}
			rows={4}
			spellcheck="false"
			class="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm transition-colors placeholder:font-sans placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none {schemaError
				? 'border-destructive focus-visible:ring-destructive'
				: ''}"
		></textarea>
		{#if schemaError}
			<p class="text-xs text-destructive">{schemaError}</p>
		{:else}
			<p class="text-xs text-muted-foreground">
				When set, the agent must respond with valid JSON matching this schema.
			</p>
		{/if}
	</div>

	<!-- Error handling -->
	<div class="space-y-2">
		<Label>Error handling</Label>
		<Select.Root
			type="single"
			value={errorAction}
			onValueChange={(v) => {
				errorAction = v as 'stop' | 'continue' | 'retry';
				emit();
			}}
		>
			<Select.Trigger class="w-full">{errorActionLabel}</Select.Trigger>
			<Select.Content>
				<Select.Item value="stop" label="Stop workflow">Stop workflow</Select.Item>
				<Select.Item value="continue" label="Continue">Continue to next step</Select.Item>
				<Select.Item value="retry" label="Retry">Retry</Select.Item>
			</Select.Content>
		</Select.Root>

		{#if errorAction === 'retry'}
			<div class="ml-3 space-y-3 border-l-2 border-border pl-4">
				<div class="space-y-1.5">
					<Label for="step-retries-{step.id}">Max retries</Label>
					<Input
						id="step-retries-{step.id}"
						type="number"
						min={1}
						max={10}
						bind:value={maxRetries}
						oninput={emit}
						class="w-24"
					/>
				</div>
				<div class="space-y-1.5">
					<Label>After retries exhausted</Label>
					<Select.Root
						type="single"
						value={fallbackAction}
						onValueChange={(v) => {
							fallbackAction = v as 'stop' | 'continue';
							emit();
						}}
					>
						<Select.Trigger class="w-full">{fallbackActionLabel}</Select.Trigger>
						<Select.Content>
							<Select.Item value="stop" label="Stop workflow">Stop workflow</Select.Item>
							<Select.Item value="continue" label="Continue">Continue to next step</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>
			</div>
		{/if}
	</div>
</div>
