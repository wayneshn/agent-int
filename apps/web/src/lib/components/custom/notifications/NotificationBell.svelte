<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { api } from '$lib/api.client';
	import type { AppNotification, NotificationsListData } from '@repo/types';
	import BellIcon from '@lucide/svelte/icons/bell';

	/** How often the unread count is refreshed (ms) */
	const POLL_INTERVAL_MS = 30_000;

	let notifications = $state<AppNotification[]>([]);
	let unreadCount = $state(0);
	let open = $state(false);

	async function refresh(): Promise<void> {
		try {
			const res = await api('/notifications?limit=15');
			if (!res.ok) return;
			const json = (await res.json()) as { success: boolean; data?: NotificationsListData };
			if (json.success && json.data) {
				notifications = json.data.notifications;
				unreadCount = json.data.unreadCount;
			}
		} catch {
			// Transient — the next poll retries.
		}
	}

	onMount(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	});

	async function openNotification(notification: AppNotification): Promise<void> {
		if (!notification.isRead) {
			void api(`/notifications/${notification.id}/read`, { method: 'POST' }).then(() => refresh());
		}
		open = false;
		if (notification.linkPath) {
			await goto(notification.linkPath);
		}
	}

	async function markAllRead(): Promise<void> {
		await api('/notifications/read-all', { method: 'POST' });
		await refresh();
	}

	function fmtTime(date: Date | string): string {
		const d = new Date(date);
		const diff = Date.now() - d.getTime();
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}
</script>

<DropdownMenu.Root bind:open>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="sm"
				class="relative text-muted-foreground hover:text-foreground"
				title="Notifications"
			>
				<BellIcon class="size-4" />
				{#if unreadCount > 0}
					<span
						class="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[9px] font-medium text-white"
					>
						{unreadCount > 9 ? '9+' : unreadCount}
					</span>
				{/if}
				<span class="sr-only">Notifications ({unreadCount} unread)</span>
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-96">
		<div class="flex items-center justify-between px-2 py-1.5">
			<span class="text-sm font-medium">Notifications</span>
			{#if unreadCount > 0}
				<Button variant="ghost" size="sm" class="h-6 text-xs" onclick={markAllRead}>
					Mark all read
				</Button>
			{/if}
		</div>
		<DropdownMenu.Separator />
		{#if notifications.length === 0}
			<p class="px-2 py-6 text-center text-xs text-muted-foreground">No notifications yet.</p>
		{:else}
			<div class="max-h-96 overflow-y-auto">
				{#each notifications as notification (notification.id)}
					<DropdownMenu.Item
						class="flex cursor-pointer flex-col items-start gap-0.5 px-2 py-2"
						onclick={() => openNotification(notification)}
					>
						<div class="flex w-full items-center gap-2">
							{#if !notification.isRead}
								<span class="size-1.5 shrink-0 rounded-full bg-destructive"></span>
							{/if}
							<span class="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
								{notification.title}
							</span>
							<span class="shrink-0 text-[10px] text-muted-foreground">
								{fmtTime(notification.createdAt)}
							</span>
						</div>
						{#if notification.body}
							<p class="line-clamp-2 pl-3.5 text-xs text-muted-foreground">{notification.body}</p>
						{/if}
					</DropdownMenu.Item>
				{/each}
			</div>
		{/if}
	</DropdownMenu.Content>
</DropdownMenu.Root>
