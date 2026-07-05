import { createLibrary, defineComponent, type Library } from '@openuidev/lang-core';
import { z } from 'zod';

/**
 * Names of every component in the chat UI library. The web app must provide a
 * Svelte renderer for each; the agent runtime builds the library with no
 * renderers (schema only) for prompt generation and validation.
 */
export type ChatUiComponentName =
	| 'TextContent'
	| 'Badge'
	| 'Alert'
	| 'KeyValue'
	| 'Table'
	| 'Link'
	| 'Divider'
	| 'Image'
	| 'Stat'
	| 'Progress'
	| 'CodeBlock'
	| 'ListBlock'
	| 'Steps'
	| 'BarChart'
	| 'LineChart'
	| 'PieChart'
	| 'Input'
	| 'Textarea'
	| 'Select'
	| 'Checkbox'
	| 'Switch'
	| 'RadioGroup'
	| 'Slider'
	| 'Button'
	| 'Buttons'
	| 'FollowUpBlock'
	| 'Form'
	| 'Card'
	| 'TabItem'
	| 'Tabs'
	| 'AccordionItem'
	| 'Accordion'
	| 'Column'
	| 'Columns'
	| 'Stack';

/** Accent hues the model can pick; each maps 1:1 to a --chart-N CSS token. */
export type ChatUiAccent = 'orange' | 'blue' | 'green' | 'violet' | 'pink';

const ACCENT_ORDER: ChatUiAccent[] = ['orange', 'blue', 'green', 'violet', 'pink'];

/**
 * Resolve an accent name to its chart CSS variable. 'orange' (the brand
 * default) is --chart-1; used by web renderers so the mapping stays
 * single-sourced with the schema enum.
 */
export function accentChartVar(accent?: ChatUiAccent): string {
	const index = accent ? ACCENT_ORDER.indexOf(accent) : 0;
	return `var(--chart-${index < 0 ? 1 : index + 1})`;
}

/**
 * The five-slot chart series palette in order, starting at the given accent
 * and wrapping around. Multi-series charts always start at slot 1.
 */
export function chartPalette(startAccent?: ChatUiAccent): string[] {
	const start = startAccent ? Math.max(ACCENT_ORDER.indexOf(startAccent), 0) : 0;
	return ACCENT_ORDER.map((_, i) => `var(--chart-${((start + i) % ACCENT_ORDER.length) + 1})`);
}

/**
 * Build the chat UI component library shared by the web renderer and the
 * agent runtime's render_ui tool.
 *
 * IMPORTANT: zod key order defines the POSITIONAL argument order in OpenUI
 * Lang (e.g. `Button("Save", "save it", "outline")`). Required props must come
 * first; reordering existing keys is a breaking change for already-persisted
 * UI code — new props may only be APPENDED as optional at the end.
 *
 * @param impl Per-component renderer map. The web app passes its Svelte
 *   components; the agent runtime passes nothing (schema-only library).
 */
export function buildChatUiLibrary<C = unknown>(
	impl: Partial<Record<ChatUiComponentName, C>> = {},
): Library<C> {
	const c = (name: ChatUiComponentName): C => (impl[name] ?? null) as C;

	const accentEnum = z
		.enum(['orange', 'blue', 'green', 'violet', 'pink'])
		.describe('Accent color. Omit for the default theme accent (orange).');

	const rulesSchema = z
		.array(z.string())
		.describe(
			'Validation rules from: "required", "email", "minLength:N", "maxLength:N", "min:N", ' +
				'"max:N", "pattern:REGEX". Invalid fields show inline errors and block submission.',
		);

	// ── Text & data leaves ────────────────────────────────────────────────────

	const TextContent = defineComponent({
		name: 'TextContent',
		description: 'A block of text. Supports plain text only (no markdown).',
		props: z.object({
			text: z.string().describe('The text to display'),
			size: z
				.enum(['small', 'normal', 'heading'])
				.optional()
				.describe('Text size, defaults to "normal"'),
		}),
		component: c('TextContent'),
	});

	const Badge = defineComponent({
		name: 'Badge',
		description: 'A small status/label pill, e.g. for states or categories.',
		props: z.object({
			text: z.string(),
			variant: z
				.enum(['default', 'secondary', 'destructive', 'outline'])
				.optional()
				.describe('Visual style, defaults to "default"'),
		}),
		component: c('Badge'),
	});

	const Alert = defineComponent({
		name: 'Alert',
		description: 'A highlighted callout box for important information.',
		props: z.object({
			text: z.string(),
			variant: z
				.enum(['info', 'success', 'warning', 'error'])
				.optional()
				.describe('Tone of the alert, defaults to "info"'),
			title: z.string().optional().describe('Optional bold title above the text'),
		}),
		component: c('Alert'),
	});

	const KeyValue = defineComponent({
		name: 'KeyValue',
		description: 'A two-column list of label/value pairs, e.g. for a summary of facts.',
		props: z.object({
			pairs: z
				.array(z.object({ label: z.string(), value: z.union([z.string(), z.number()]) }))
				.describe('The label/value rows to display'),
		}),
		component: c('KeyValue'),
	});

	const Table = defineComponent({
		name: 'Table',
		description: 'A data table with a header row and data rows.',
		props: z.object({
			headers: z.array(z.string()).describe('Column headers'),
			rows: z
				.array(z.array(z.union([z.string(), z.number()])))
				.describe('Data rows; each row must have one cell per header'),
			density: z
				.enum(['comfortable', 'compact'])
				.optional()
				.describe('Row spacing, defaults to "comfortable"'),
		}),
		component: c('Table'),
	});

	const Link = defineComponent({
		name: 'Link',
		description: 'A hyperlink that opens in a new tab.',
		props: z.object({
			text: z.string(),
			url: z.string().describe('Absolute URL, e.g. "https://example.com"'),
		}),
		component: c('Link'),
	});

	const Divider = defineComponent({
		name: 'Divider',
		description: 'A horizontal separator line, optionally with a small centered label.',
		props: z.object({
			label: z.string().optional(),
		}),
		component: c('Divider'),
	});

	const Image = defineComponent({
		name: 'Image',
		description: 'An image loaded from a remote URL, with rounded corners and an optional caption.',
		props: z.object({
			url: z.string().describe('Absolute https image URL'),
			alt: z.string().describe('Short alt text for accessibility'),
			caption: z.string().optional().describe('Caption shown under the image'),
		}),
		component: c('Image'),
	});

	const Stat = defineComponent({
		name: 'Stat',
		description:
			'A stat tile: big headline number with a label and optional trend delta. ' +
			'Put several in a Columns row to lead a dashboard.',
		props: z.object({
			label: z.string().describe('What the number measures, e.g. "Monthly revenue"'),
			value: z.string().describe('Pre-formatted value, e.g. "$48.2k" or "1,204"'),
			delta: z.string().optional().describe('Change caption, e.g. "+12% vs last month"'),
			trend: z
				.enum(['up', 'down', 'flat'])
				.optional()
				.describe('Colors the delta and picks the arrow icon'),
			accent: accentEnum.optional(),
		}),
		component: c('Stat'),
	});

	const Progress = defineComponent({
		name: 'Progress',
		description: 'A horizontal progress bar.',
		props: z.object({
			value: z.number().describe('Progress percentage, 0-100'),
			label: z.string().optional().describe('Label shown above the bar'),
			accent: accentEnum.optional(),
		}),
		component: c('Progress'),
	});

	const CodeBlock = defineComponent({
		name: 'CodeBlock',
		description: 'A syntax-highlighted code snippet with a copy button.',
		props: z.object({
			code: z.string(),
			language: z
				.string()
				.optional()
				.describe('e.g. "python", "sql", "json"; auto-detected if omitted'),
		}),
		component: c('CodeBlock'),
	});

	const ListBlock = defineComponent({
		name: 'ListBlock',
		description: 'A vertical list of rows, each with a title and optional subtitle and badge.',
		props: z.object({
			items: z
				.array(
					z.object({
						title: z.string(),
						subtitle: z.string().optional(),
						badge: z.string().optional(),
					}),
				)
				.describe('The rows to display'),
		}),
		component: c('ListBlock'),
	});

	const Steps = defineComponent({
		name: 'Steps',
		description:
			'An ordered sequence of steps with per-step status, e.g. an onboarding or task plan.',
		props: z.object({
			steps: z
				.array(
					z.object({
						label: z.string(),
						description: z.string().optional(),
						status: z.enum(['done', 'active', 'pending']).optional(),
					}),
				)
				.describe('Steps in order; status defaults to "pending"'),
		}),
		component: c('Steps'),
	});

	// ── Charts ────────────────────────────────────────────────────────────────

	const seriesSchema = z
		.array(
			z.object({
				name: z.string().describe('Series name, shown in the legend'),
				data: z.array(z.number()).describe('One number per label, same length as labels'),
			}),
		)
		.describe('The data series (1-5)');

	const BarChart = defineComponent({
		name: 'BarChart',
		description: 'A bar chart for comparing values across categories.',
		props: z.object({
			labels: z.array(z.string()).describe('Category labels along the x-axis'),
			series: seriesSchema,
			title: z.string().optional().describe('Chart title; include the unit, e.g. "Revenue ($k)"'),
			variant: z
				.enum(['grouped', 'stacked', 'horizontal'])
				.optional()
				.describe('Defaults to "grouped"; "horizontal" suits a single series with long labels'),
			accent: accentEnum
				.optional()
				.describe('Hue for a SINGLE-series chart; multi-series charts use the palette in order'),
		}),
		component: c('BarChart'),
	});

	const LineChart = defineComponent({
		name: 'LineChart',
		description: 'A line chart for trends over time or ordered values.',
		props: z.object({
			labels: z.array(z.string()).describe('X-axis point labels in order, e.g. months'),
			series: seriesSchema,
			title: z.string().optional().describe('Chart title; include the unit'),
			variant: z
				.enum(['line', 'area'])
				.optional()
				.describe('"area" fills under the line; defaults to "line"'),
			accent: accentEnum
				.optional()
				.describe('Hue for a SINGLE-series chart; multi-series charts use the palette in order'),
		}),
		component: c('LineChart'),
	});

	const PieChart = defineComponent({
		name: 'PieChart',
		description: 'A pie/donut chart for proportions of a whole. Use at most 6 slices.',
		props: z.object({
			slices: z
				.array(z.object({ label: z.string(), value: z.number() }))
				.describe('The slices; values are absolute (percentages computed automatically)'),
			title: z.string().optional(),
			variant: z.enum(['pie', 'donut']).optional().describe('Defaults to "pie"'),
			accent: accentEnum.optional().describe('Palette start hue'),
		}),
		component: c('PieChart'),
	});

	// ── Form fields ───────────────────────────────────────────────────────────

	const Input = defineComponent({
		name: 'Input',
		description: 'A single-line text input field. Must be placed inside a Form.',
		props: z.object({
			name: z.string().describe('Field name used as the key in the submitted form data'),
			label: z.string().optional().describe('Label shown above the field'),
			placeholder: z.string().optional(),
			type: z
				.enum(['text', 'email', 'number', 'date'])
				.optional()
				.describe('Input type, defaults to "text"'),
			rules: rulesSchema.optional(),
		}),
		component: c('Input'),
	});

	const Textarea = defineComponent({
		name: 'Textarea',
		description: 'A multi-line text input field. Must be placed inside a Form.',
		props: z.object({
			name: z.string().describe('Field name used as the key in the submitted form data'),
			label: z.string().optional().describe('Label shown above the field'),
			placeholder: z.string().optional(),
			rules: rulesSchema.optional(),
		}),
		component: c('Textarea'),
	});

	const Select = defineComponent({
		name: 'Select',
		description: 'A dropdown select field. Must be placed inside a Form.',
		props: z.object({
			name: z.string().describe('Field name used as the key in the submitted form data'),
			options: z.array(z.string()).describe('The selectable options'),
			label: z.string().optional().describe('Label shown above the field'),
			placeholder: z.string().optional(),
			rules: rulesSchema.optional().describe('Only "required" is meaningful for Select'),
		}),
		component: c('Select'),
	});

	const Checkbox = defineComponent({
		name: 'Checkbox',
		description: 'A checkbox producing a true/false value. Must be placed inside a Form.',
		props: z.object({
			name: z.string().describe('Field name used as the key in the submitted form data'),
			label: z.string().describe('Text shown next to the checkbox'),
			rules: rulesSchema.optional().describe('e.g. ["required"] to force checking'),
		}),
		component: c('Checkbox'),
	});

	const Switch = defineComponent({
		name: 'Switch',
		description: 'An on/off toggle producing a true/false value. Must be placed inside a Form.',
		props: z.object({
			name: z.string().describe('Field name used as the key in the submitted form data'),
			label: z.string().describe('Text shown next to the toggle'),
		}),
		component: c('Switch'),
	});

	const RadioGroup = defineComponent({
		name: 'RadioGroup',
		description: 'A single-choice group of radio buttons. Must be placed inside a Form.',
		props: z.object({
			name: z.string().describe('Field name used as the key in the submitted form data'),
			options: z.array(z.string()).describe('The selectable options'),
			label: z.string().optional().describe('Label shown above the group'),
			rules: rulesSchema.optional().describe('Only "required" is meaningful for RadioGroup'),
		}),
		component: c('RadioGroup'),
	});

	const Slider = defineComponent({
		name: 'Slider',
		description: 'A numeric slider. Must be placed inside a Form.',
		props: z.object({
			name: z.string().describe('Field name used as the key in the submitted form data'),
			label: z.string().optional().describe('Label shown above the slider'),
			min: z.number().optional().describe('Defaults to 0'),
			max: z.number().optional().describe('Defaults to 100'),
			step: z.number().optional().describe('Defaults to 1'),
		}),
		component: c('Slider'),
	});

	// ── Actions ───────────────────────────────────────────────────────────────

	const Button = defineComponent({
		name: 'Button',
		description:
			'A clickable button. Clicking it sends `message` (or the label if omitted) back to you as ' +
			'the user\'s next chat message — make the message self-describing, e.g. "I choose the Pro plan".',
		props: z.object({
			label: z.string().describe('Text shown on the button'),
			message: z
				.string()
				.optional()
				.describe('Chat message sent to the assistant on click; defaults to the label'),
			variant: z
				.enum(['default', 'outline', 'destructive'])
				.optional()
				.describe('Visual style, defaults to "default"'),
		}),
		component: c('Button'),
	});

	const Buttons = defineComponent({
		name: 'Buttons',
		description: 'A horizontal row of Buttons, e.g. for presenting choices.',
		props: z.object({
			buttons: z.array(Button.ref),
		}),
		component: c('Buttons'),
	});

	const FollowUpBlock = defineComponent({
		name: 'FollowUpBlock',
		description:
			'A row of suggestion chips for likely next questions. Clicking a chip sends its text as ' +
			"the user's next message. Place it last in the Stack.",
		props: z.object({
			suggestions: z
				.array(z.string())
				.describe('2-4 short follow-up prompts, phrased as the user would say them'),
		}),
		component: c('FollowUpBlock'),
	});

	// ── Containers ────────────────────────────────────────────────────────────
	// Containment is one-directional to keep `.ref` acyclic:
	//   leaves/charts/Form → Card → TabItem/AccordionItem/Column → Stack

	const formChild = z.union([
		Input.ref,
		Textarea.ref,
		Select.ref,
		TextContent.ref,
		Alert.ref,
		Checkbox.ref,
		RadioGroup.ref,
		Switch.ref,
		Slider.ref,
		Divider.ref,
	]);

	const Form = defineComponent({
		name: 'Form',
		description:
			'A form that collects user input. Renders its own submit button; on submit the field ' +
			"values are sent back to you as JSON in the user's next chat message.",
		props: z.object({
			name: z.string().describe('Unique form name, e.g. "signup"'),
			children: z.array(formChild).describe('Form fields (Input, Textarea, Select) and text'),
			submitLabel: z.string().optional().describe('Submit button text, defaults to "Submit"'),
		}),
		component: c('Form'),
	});

	const cardChild = z.union([
		TextContent.ref,
		Badge.ref,
		Alert.ref,
		KeyValue.ref,
		Table.ref,
		Link.ref,
		Button.ref,
		Buttons.ref,
		Form.ref,
		Divider.ref,
		Image.ref,
		Stat.ref,
		Progress.ref,
		CodeBlock.ref,
		ListBlock.ref,
		Steps.ref,
		BarChart.ref,
		LineChart.ref,
		PieChart.ref,
	]);

	const Card = defineComponent({
		name: 'Card',
		description: 'A bordered container that groups related content, with an optional title.',
		props: z.object({
			children: z.array(cardChild),
			title: z.string().optional().describe('Optional card heading'),
			accent: accentEnum.optional().describe('Adds a colored left edge to emphasize the card'),
		}),
		component: c('Card'),
	});

	const sectionChild = z.union([
		TextContent.ref,
		Badge.ref,
		Alert.ref,
		KeyValue.ref,
		Table.ref,
		Link.ref,
		Button.ref,
		Buttons.ref,
		Form.ref,
		Divider.ref,
		Image.ref,
		Stat.ref,
		Progress.ref,
		CodeBlock.ref,
		ListBlock.ref,
		Steps.ref,
		BarChart.ref,
		LineChart.ref,
		PieChart.ref,
		Card.ref,
	]);

	const TabItem = defineComponent({
		name: 'TabItem',
		description: 'One tab: a trigger title and its content. Only used inside Tabs.',
		props: z.object({
			title: z.string().describe('Tab trigger text'),
			children: z.array(sectionChild),
		}),
		component: c('TabItem'),
	});

	const Tabs = defineComponent({
		name: 'Tabs',
		description: 'A tabbed container; the first tab is selected initially.',
		props: z.object({
			tabs: z.array(TabItem.ref).describe('2-5 TabItems'),
		}),
		component: c('Tabs'),
	});

	const AccordionItem = defineComponent({
		name: 'AccordionItem',
		description: 'One collapsible section. Only used inside Accordion.',
		props: z.object({
			title: z.string(),
			children: z.array(sectionChild),
		}),
		component: c('AccordionItem'),
	});

	const Accordion = defineComponent({
		name: 'Accordion',
		description: 'Vertically stacked collapsible sections; good for FAQs and long detail lists.',
		props: z.object({
			items: z.array(AccordionItem.ref),
		}),
		component: c('Accordion'),
	});

	const Column = defineComponent({
		name: 'Column',
		description: 'Groups several components into ONE cell of a Columns grid.',
		props: z.object({
			children: z.array(sectionChild),
		}),
		component: c('Column'),
	});

	const Columns = defineComponent({
		name: 'Columns',
		description:
			'A responsive grid. Each child is one cell (use Column to stack multiple items in a ' +
			'cell). Collapses to a single column on small screens.',
		props: z.object({
			children: z
				.array(
					z.union([
						TextContent.ref,
						Badge.ref,
						Alert.ref,
						KeyValue.ref,
						Table.ref,
						Link.ref,
						Button.ref,
						Buttons.ref,
						Form.ref,
						Divider.ref,
						Image.ref,
						Stat.ref,
						Progress.ref,
						CodeBlock.ref,
						ListBlock.ref,
						Steps.ref,
						BarChart.ref,
						LineChart.ref,
						PieChart.ref,
						Card.ref,
						Column.ref,
					]),
				)
				.describe('One component per cell, or Column to stack several in a cell'),
			columns: z
				.number()
				.optional()
				.describe('Columns on desktop (2-4); defaults to the child count, capped at 3'),
		}),
		component: c('Columns'),
	});

	const Stack = defineComponent({
		name: 'Stack',
		description: 'The top-level vertical layout container. Every UI starts with a Stack.',
		props: z.object({
			children: z.array(
				z.union([
					TextContent.ref,
					Badge.ref,
					Alert.ref,
					KeyValue.ref,
					Table.ref,
					Link.ref,
					Button.ref,
					Buttons.ref,
					Form.ref,
					Card.ref,
					Tabs.ref,
					Accordion.ref,
					Columns.ref,
					Divider.ref,
					Image.ref,
					Stat.ref,
					Progress.ref,
					CodeBlock.ref,
					ListBlock.ref,
					Steps.ref,
					FollowUpBlock.ref,
					BarChart.ref,
					LineChart.ref,
					PieChart.ref,
				]),
			),
		}),
		component: c('Stack'),
	});

	return createLibrary({
		root: 'Stack',
		components: [
			Stack,
			Card,
			Columns,
			Column,
			Tabs,
			TabItem,
			Accordion,
			AccordionItem,
			Divider,
			TextContent,
			Badge,
			Alert,
			KeyValue,
			Table,
			ListBlock,
			Steps,
			CodeBlock,
			Link,
			Image,
			Stat,
			Progress,
			BarChart,
			LineChart,
			PieChart,
			Form,
			Input,
			Textarea,
			Select,
			Checkbox,
			RadioGroup,
			Switch,
			Slider,
			Button,
			Buttons,
			FollowUpBlock,
		],
		componentGroups: [
			{
				name: 'Layout',
				components: [
					'Stack',
					'Card',
					'Columns',
					'Column',
					'Tabs',
					'TabItem',
					'Accordion',
					'AccordionItem',
					'Divider',
				],
				notes: [
					'Stack is always the root. Group related content in Cards — the chat frame adds no chrome of its own.',
					'Columns for side-by-side content (stat rows, card grids); Tabs when content splits into alternative views; Accordion for long optional detail.',
					'Tabs, Accordion and Columns live directly in the Stack — they cannot be nested inside a Card.',
				],
			},
			{
				name: 'Text & data',
				components: [
					'TextContent',
					'Badge',
					'Alert',
					'KeyValue',
					'Table',
					'ListBlock',
					'Steps',
					'CodeBlock',
					'Link',
					'Image',
				],
				notes: [
					'Table for uniform columns; ListBlock for heterogeneous rows with title/subtitle/badge; Steps for ordered progress.',
				],
			},
			{
				name: 'Stats & charts',
				components: ['Stat', 'Progress', 'BarChart', 'LineChart', 'PieChart'],
				notes: [
					'Use BarChart to compare categories, LineChart for trends over time ("area" variant to emphasize volume), PieChart only for parts of a whole with at most 6 slices.',
					'A single headline number is a Stat tile, not a chart. Lead dashboards with a Columns row of Stats.',
					'Only chart numbers you actually have — never invent data. Put the unit in the title or the value strings.',
				],
			},
			{
				name: 'Forms',
				components: [
					'Form',
					'Input',
					'Textarea',
					'Select',
					'Checkbox',
					'RadioGroup',
					'Switch',
					'Slider',
				],
				notes: [
					'Fields live inside a Form; it renders its own submit button and returns the values to you as JSON.',
					'Add rules (e.g. ["required", "email"]) to fields that need them — invalid fields show inline errors and block submission.',
				],
			},
			{
				name: 'Actions',
				components: ['Button', 'Buttons', 'FollowUpBlock'],
				notes: [
					'End a view with FollowUpBlock chips when natural next questions exist. Buttons are for decisions; chips are for exploration.',
				],
			},
		],
	}) as Library<C>;
}

/**
 * OpenUI Lang guide injected into the render_ui tool description. Generated
 * from the same library the web renderer uses, so signatures cannot drift.
 * toolCalls/bindings are disabled: the Svelte runtime has no Query/Mutation
 * bridge and no $variable store — the UI is static markup plus form/button
 * actions that round-trip through normal chat messages.
 */
export function buildRenderUiGuide(): string {
	return buildChatUiLibrary().prompt({
		preamble:
			'The `code` parameter must contain valid openui-lang, a declarative UI language — ' +
			'no markdown, no explanations, just openui-lang statements.',
		toolCalls: false,
		bindings: false,
		editMode: false,
		inlineMode: false,
		additionalRules: [
			'Keep the UI compact — it renders inside a chat column roughly 800px wide.',
			'Use only the components listed above. Do not use Query, Mutation, $variables, or @action steps.',
			'Place Input/Textarea/Select/Checkbox/RadioGroup/Switch/Slider fields only inside a Form. The Form renders its own submit button.',
			'For a set of choices, prefer Buttons with one Button per option.',
			'Omit accent props unless the user asked for a specific color or a stored design preference says so — the default theme accent applies otherwise.',
		],
		examples: [
			'root = Stack([title, stats, chart, chips])\n' +
				'title = TextContent("Q1 revenue overview", "heading")\n' +
				'stats = Columns([s1, s2, s3])\n' +
				's1 = Stat("Revenue", "$48.2k", "+12% vs Q4", "up")\n' +
				's2 = Stat("New customers", "312", "+8%", "up")\n' +
				's3 = Stat("Churn", "2.1%", "-0.4pt", "down")\n' +
				'chart = BarChart(["Jan", "Feb", "Mar"], [{name: "Revenue", data: [14.1, 15.8, 18.3]}], "Monthly revenue ($k)")\n' +
				'chips = FollowUpBlock(["Break revenue down by product", "Compare with last year"])',
			'root = Stack([form])\n' +
				'form = Form("signup", [name, email, plan, terms], "Create account")\n' +
				'name = Input("name", "Full name", "Jane Doe", "text", ["required", "minLength:2"])\n' +
				'email = Input("email", "Work email", "you@company.com", "email", ["required", "email"])\n' +
				'plan = RadioGroup("plan", ["Free", "Pro", "Enterprise"], "Plan", ["required"])\n' +
				'terms = Checkbox("terms", "I accept the terms", ["required"])',
			'root = Stack([tabs])\n' +
				'tabs = Tabs([t1, t2])\n' +
				't1 = TabItem("Summary", [kv])\n' +
				't2 = TabItem("All items", [tbl])\n' +
				'kv = KeyValue([{label: "Total", value: "$1,204"}, {label: "Items", value: 17}])\n' +
				'tbl = Table(["Item", "Qty", "Price"], [["Widget", 3, "$36"], ["Gadget", 1, "$99"]], "compact")',
		],
	});
}

/**
 * JSON schema of the library, for validating agent-generated code with
 * lang-core's createParser without constructing renderer components.
 */
export function buildChatUiJsonSchema() {
	return buildChatUiLibrary().toJSONSchema();
}
