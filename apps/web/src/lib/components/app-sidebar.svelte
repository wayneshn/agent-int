<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { authStore } from '$lib/stores/auth.store.js';
	import { themeStore } from '$lib/stores/theme.store.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { useSidebar } from '$lib/components/ui/sidebar/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import HouseIcon from '@lucide/svelte/icons/house';
	import BotIcon from '@lucide/svelte/icons/bot';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import UserIcon from '@lucide/svelte/icons/user';
	import KeyIcon from '@lucide/svelte/icons/key';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import { MessageCircleMore } from '@lucide/svelte';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import type { User } from '@repo/types';

	let { user }: { user: User } = $props();

	let isDark = $derived($themeStore === 'dark');

	const sidebar = useSidebar();
	let isExpanded = $derived(sidebar.state === 'expanded');

	/** On mobile the sidebar is a sheet overlay — close it after navigation. */
	function closeMobileIfNeeded() {
		if (sidebar.isMobile) {
			sidebar.setOpenMobile(false);
		}
	}
	/** Compute display name from first/last name or fall back to email prefix */
	let displayName = $derived(
		user.first_name || user.last_name
			? [user.first_name, user.last_name].filter(Boolean).join(' ')
			: user.email.split('@')[0]
	);

	/** Single capital letter for the avatar */
	let avatarInitial = $derived(displayName.charAt(0).toUpperCase());

	/** Main navigation items */
	const navItems = [
		{ title: 'Home', url: '/app', icon: HouseIcon },
		{ title: 'Chat', url: '/app/chat', icon: MessageSquareIcon },
		{ title: 'Agents', url: '/app/agents', icon: BotIcon },
		{ title: 'Workflows', url: '/app/workflows', icon: WorkflowIcon },
		{ title: 'Credentials', url: '/app/credentials', icon: ShieldIcon },
		{ title: 'Skills', url: '/app/skills', icon: SparklesIcon },
		{ title: 'Knowledge', url: '/app/knowledge', icon: BookOpenIcon },
		{ title: 'MCP Servers', url: '/app/mcp-servers', icon: PlugIcon },
		{ title: 'LLM Providers', url: '/app/llm-providers', icon: CpuIcon }
	];

	/** Account dropdown items */
	const accountItems = [
		{ title: 'Profile', url: '/app/account/profile', icon: UserIcon },
		{ title: 'API Keys', url: '/app/account/api-keys', icon: KeyIcon },
		{ title: 'Channels', url: '/app/account/channels', icon: MessageCircleMore }
	];

	/** Navigate to a path, closing the mobile sidebar sheet first if open. */
	function navigateTo(url: string) {
		closeMobileIfNeeded();
		goto(url);
	}

	/**
	 * A nav item is active on its exact path and any nested path beneath it,
	 * e.g. "Chat" (`/app/chat`) stays highlighted on `/app/chat/[agentId]/...`.
	 * "Home" (`/app`) is matched exactly so it doesn't light up on every page.
	 */
	function isActive(url: string): boolean {
		const path = page.url.pathname;
		if (url === '/app') return path === '/app';
		return path === url || path.startsWith(`${url}/`);
	}

	async function handleLogout() {
		closeMobileIfNeeded();
		authStore.logout();
		goto('/signin');
	}
</script>

<Sidebar.Root collapsible="icon">
	<!-- Header: app branding -->
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton size="lg" class="pointer-events-none">
					<img src="/valmis/icon.svg" alt="Valmis" class="size-6 shrink-0" />
					<div class="flex flex-col gap-0.5 leading-none">
						<span class="font-heading text-sm font-semibold">Valmis</span>
						<span class="text-xs text-muted-foreground">Get work done</span>
					</div>
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<!-- Main navigation -->
	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupLabel>Navigation</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each navItems as item (item.title)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton isActive={isActive(item.url)} tooltipContent={item.title}>
								{#snippet child({ props })}
									<a href={item.url} {...props} onclick={closeMobileIfNeeded}>
										<item.icon />
										<span>{item.title}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<!-- Footer: dark mode toggle + account dropdown -->
	<Sidebar.Footer>
		<Sidebar.Menu>
			<!-- Dark mode toggle: full row when expanded, switch-only when collapsed -->
			<Sidebar.MenuItem>
				{#if isExpanded}
					<div class="flex items-center gap-3 px-2 py-1.5">
						<MoonIcon class="size-4 shrink-0 text-muted-foreground" />
						<Label for="dark-mode-switch" class="flex-1 cursor-pointer text-sm">Dark Mode</Label>
						<Switch
							id="dark-mode-switch"
							class="data-unchecked:bg-foreground"
							checked={isDark}
							onCheckedChange={(checked) => themeStore.setTheme(checked ? 'dark' : 'light')}
						/>
					</div>
				{:else}
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<div class="flex items-center justify-center px-2 py-1.5" {...props}>
									<Switch
										id="dark-mode-switch-collapsed"
										class="data-unchecked:bg-foreground"
										checked={isDark}
										onCheckedChange={(checked) => themeStore.setTheme(checked ? 'dark' : 'light')}
									/>
								</div>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="right" align="center">Dark Mode</Tooltip.Content>
					</Tooltip.Root>
				{/if}
			</Sidebar.MenuItem>

			<!-- Account dropdown -->
			<Sidebar.MenuItem>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Sidebar.MenuButton
								size="lg"
								class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
								tooltipContent={user.email}
								{...props}
							>
								<!-- Avatar circle with initial -->
								<div
									class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground"
								>
									{avatarInitial}
								</div>
								<div class="flex min-w-0 flex-1 flex-col text-left leading-tight">
									<span class="truncate text-sm font-medium">{displayName}</span>
									<span class="truncate text-xs text-muted-foreground">{user.email}</span>
								</div>
								<ChevronsUpDownIcon class="ml-auto size-4 shrink-0 text-muted-foreground" />
							</Sidebar.MenuButton>
						{/snippet}
					</DropdownMenu.Trigger>

					<DropdownMenu.Content
						class="w-[--bits-dropdown-menu-anchor-width] min-w-56 rounded-lg"
						side={isExpanded ? 'top' : 'right'}
						align="end"
						sideOffset={4}
					>
						<!-- Account info header -->
						<DropdownMenu.Label class="p-0 font-normal">
							<div class="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
								<div
									class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground"
								>
									{avatarInitial}
								</div>
								<div class="flex min-w-0 flex-col">
									<span class="truncate font-medium">{displayName}</span>
									<span class="truncate text-xs text-muted-foreground">{user.email}</span>
								</div>
							</div>
						</DropdownMenu.Label>

						<DropdownMenu.Separator />

						<DropdownMenu.Group>
							{#each accountItems as item (item.title)}
								<DropdownMenu.Item onSelect={() => navigateTo(item.url)}>
									<item.icon class="mr-2 size-4" />
									{item.title}
								</DropdownMenu.Item>
							{/each}
						</DropdownMenu.Group>

						<DropdownMenu.Separator />

						<DropdownMenu.Item
							onSelect={handleLogout}
							class="text-destructive focus:text-destructive"
						>
							<LogOutIcon class="mr-2 size-4" />
							Log out
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>

	<Sidebar.Rail />
</Sidebar.Root>
