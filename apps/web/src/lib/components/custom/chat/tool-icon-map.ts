import WrenchIcon from '@lucide/svelte/icons/wrench';
import DatabaseIcon from '@lucide/svelte/icons/database';
import SearchIcon from '@lucide/svelte/icons/search';
import Trash2Icon from '@lucide/svelte/icons/trash-2';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import FilePenIcon from '@lucide/svelte/icons/file-pen';
import FolderIcon from '@lucide/svelte/icons/folder';
import TerminalIcon from '@lucide/svelte/icons/terminal';
import CodeIcon from '@lucide/svelte/icons/code-2';
import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
import ListIcon from '@lucide/svelte/icons/list';
import FileSearchIcon from '@lucide/svelte/icons/file-search';
import PlayIcon from '@lucide/svelte/icons/play';
import PlusCircleIcon from '@lucide/svelte/icons/plus-circle';
import GlobeIcon from '@lucide/svelte/icons/globe';
import ScanLineIcon from '@lucide/svelte/icons/scan-line';
import MousePointerClickIcon from '@lucide/svelte/icons/mouse-pointer-click';
import KeyboardIcon from '@lucide/svelte/icons/keyboard';
import CameraIcon from '@lucide/svelte/icons/camera';
import BookOpenIcon from '@lucide/svelte/icons/book-open';
import ClockIcon from '@lucide/svelte/icons/clock';
import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
import LayoutIcon from '@lucide/svelte/icons/layout-template';
import UsersIcon from '@lucide/svelte/icons/users';
import SendIcon from '@lucide/svelte/icons/send';
import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';

/**
 * Maps built-in agent tool names to their Lucide icon constructors.
 * Used by ToolCallIndicator to render a meaningful icon for each tool type.
 * Fall back to DEFAULT_TOOL_ICON for any tool name not listed here.
 */
export const TOOL_ICON_MAP: Record<string, typeof WrenchIcon> = {
	call_api: WrenchIcon,
	memory_write: DatabaseIcon,
	memory_search: SearchIcon,
	memory_delete: Trash2Icon,
	read_file: FileTextIcon,
	write_file: FilePenIcon,
	list_files: FolderIcon,
	run_terminal: TerminalIcon,
	run_code: CodeIcon,
	ask_human: MessageCircleIcon,
	list_workflows: ListIcon,
	read_workflow: FileSearchIcon,
	trigger_workflow: PlayIcon,
	create_workflow: PlusCircleIcon,
	list_agents: UsersIcon,
	send_to_agent: SendIcon,
	ask_agent: MessagesSquareIcon,
	browser_navigate: GlobeIcon,
	browser_snapshot: ScanLineIcon,
	browser_click: MousePointerClickIcon,
	browser_type: KeyboardIcon,
	browser_select: ListIcon,
	browser_press_key: KeyboardIcon,
	browser_screenshot: CameraIcon,
	browser_read_page: BookOpenIcon,
	browser_wait_for: ClockIcon,
	browser_go_back: ArrowLeftIcon,
	browser_go_forward: ArrowRightIcon,
	render_ui: LayoutIcon
};

/** Fallback icon when a tool name is not found in TOOL_ICON_MAP */
export { WrenchIcon as DEFAULT_TOOL_ICON };
