import { buildChatUiLibrary } from '@repo/openui';
import type { Library } from '@openuidev/svelte-lang';
import UiStack from './components/UiStack.svelte';
import UiCard from './components/UiCard.svelte';
import UiColumns from './components/UiColumns.svelte';
import UiColumn from './components/UiColumn.svelte';
import UiTabs from './components/UiTabs.svelte';
import UiTabItem from './components/UiTabItem.svelte';
import UiAccordion from './components/UiAccordion.svelte';
import UiAccordionItem from './components/UiAccordionItem.svelte';
import UiDivider from './components/UiDivider.svelte';
import UiTextContent from './components/UiTextContent.svelte';
import UiBadge from './components/UiBadge.svelte';
import UiAlert from './components/UiAlert.svelte';
import UiKeyValue from './components/UiKeyValue.svelte';
import UiTable from './components/UiTable.svelte';
import UiListBlock from './components/UiListBlock.svelte';
import UiSteps from './components/UiSteps.svelte';
import UiCodeBlock from './components/UiCodeBlock.svelte';
import UiLink from './components/UiLink.svelte';
import UiImage from './components/UiImage.svelte';
import UiStat from './components/UiStat.svelte';
import UiProgress from './components/UiProgress.svelte';
import UiBarChart from './components/UiBarChart.svelte';
import UiLineChart from './components/UiLineChart.svelte';
import UiPieChart from './components/UiPieChart.svelte';
import UiForm from './components/UiForm.svelte';
import UiInput from './components/UiInput.svelte';
import UiTextarea from './components/UiTextarea.svelte';
import UiSelect from './components/UiSelect.svelte';
import UiCheckbox from './components/UiCheckbox.svelte';
import UiRadioGroup from './components/UiRadioGroup.svelte';
import UiSwitch from './components/UiSwitch.svelte';
import UiSlider from './components/UiSlider.svelte';
import UiButton from './components/UiButton.svelte';
import UiButtons from './components/UiButtons.svelte';
import UiFollowUpBlock from './components/UiFollowUpBlock.svelte';

// The renderer type svelte-lang's Library expects (ComponentRenderer<any>),
// extracted rather than written out to satisfy the no-`any` house rule.
type SvelteRenderer = Library['components'][string]['component'];

/**
 * The chat UI component library rendered by OpenUiBlock. Schemas (names, prop
 * order, descriptions) come from @repo/openui — the same source the agent's
 * render_ui tool uses for its prompt and validation — so renderer and prompt
 * cannot drift. Only the Svelte renderers are bound here.
 */
export const chatUiLibrary: Library = buildChatUiLibrary<SvelteRenderer>({
	Stack: UiStack,
	Card: UiCard,
	Columns: UiColumns,
	Column: UiColumn,
	Tabs: UiTabs,
	TabItem: UiTabItem,
	Accordion: UiAccordion,
	AccordionItem: UiAccordionItem,
	Divider: UiDivider,
	TextContent: UiTextContent,
	Badge: UiBadge,
	Alert: UiAlert,
	KeyValue: UiKeyValue,
	Table: UiTable,
	ListBlock: UiListBlock,
	Steps: UiSteps,
	CodeBlock: UiCodeBlock,
	Link: UiLink,
	Image: UiImage,
	Stat: UiStat,
	Progress: UiProgress,
	BarChart: UiBarChart,
	LineChart: UiLineChart,
	PieChart: UiPieChart,
	Form: UiForm,
	Input: UiInput,
	Textarea: UiTextarea,
	Select: UiSelect,
	Checkbox: UiCheckbox,
	RadioGroup: UiRadioGroup,
	Switch: UiSwitch,
	Slider: UiSlider,
	Button: UiButton,
	Buttons: UiButtons,
	FollowUpBlock: UiFollowUpBlock
});
