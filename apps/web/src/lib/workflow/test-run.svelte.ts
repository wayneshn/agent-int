import type { WorkflowStepLog, WorkflowStepLogStatus, WorkflowRunStatus } from '@repo/types';

/**
 * Shared, builder-scoped Test-mode state. A module-level runes store is the simplest way to
 * feed live per-step run data into Svelte Flow's custom node components (which are instantiated
 * by the flow, not as direct children of the builder). The builder owns the poller and updates
 * this; node components + the config Sheet read it. Reset on builder mount/unmount.
 */
export const testRun = $state<{
	/** A test run exists (drives node overlays). */
	active: boolean;
	/** Live status of the current test run. */
	status: WorkflowRunStatus | null;
	/** Latest step log per canvas node id (stepId === node id). */
	logByNodeId: Record<string, WorkflowStepLog>;
	/** The seed trigger payload of the current test run (shown on the trigger node). */
	seedPayload: Record<string, unknown> | null;
	/** Set by the builder: run the workflow up to `nodeId` (undefined ⇒ full run). */
	runNode: ((nodeId?: string) => void) | null;
	/** True while a test run is starting/executing (disables the run buttons). */
	busy: boolean;
	/** Whether testing is currently allowed (saved workflow, no unsaved changes). */
	canTest: boolean;
}>({
	active: false,
	status: null,
	logByNodeId: {},
	seedPayload: null,
	runNode: null,
	busy: false,
	canTest: false
});

/** Clear the run overlay (keeps runNode/canTest, which the builder manages). */
export function resetTestRun(): void {
	testRun.active = false;
	testRun.status = null;
	testRun.logByNodeId = {};
	testRun.seedPayload = null;
	testRun.busy = false;
}

/** Test status of one node in the current run, or null if it has no log yet. */
export function nodeStatus(nodeId: string): WorkflowStepLogStatus | null {
	return testRun.logByNodeId[nodeId]?.status ?? null;
}

/** Border/ring classes for a node container reflecting its test status. */
export function nodeRingClass(nodeId: string): string {
	switch (nodeStatus(nodeId)) {
		case 'success':
			return 'border-green-500 ring-1 ring-green-500/40';
		case 'failed':
			return 'border-destructive ring-1 ring-destructive/40';
		case 'running':
			return 'border-primary ring-1 ring-primary/40 animate-pulse';
		case 'skipped':
			return 'opacity-50';
		default:
			return '';
	}
}
