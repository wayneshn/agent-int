<script lang="ts">
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import AppSidebar from '$lib/components/app-sidebar.svelte';
	import AppBreadcrumb from '$lib/components/app-breadcrumb.svelte';
	import NotificationBell from '$lib/components/custom/notifications/NotificationBell.svelte';
	import type { LayoutData } from './$types';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();
</script>

<Sidebar.Provider>
	<AppSidebar user={data.user} />
	<Sidebar.Inset>
		<!-- Top header bar with sidebar trigger and breadcrumb navigation -->
		<!-- h-[72px] matches sidebar header height (p-2 + h-14 + p-2) -->
		<header class="flex h-[72px] shrink-0 items-center gap-2 border-b border-border/50 px-4">
			<Sidebar.Trigger class="-ml-1 text-muted-foreground hover:text-foreground" />
			<!-- Subtle vertical divider between trigger and breadcrumb -->
			<div class="mx-1 h-4 w-px bg-border/60"></div>
			<AppBreadcrumb />
			<div class="ml-auto">
				<NotificationBell />
			</div>
		</header>

		<!-- Page content -->
		<main class="flex flex-1 flex-col gap-6 p-6">
			{@render children()}
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>
