import type { ElementNode } from '@openuidev/svelte-lang';

/** Narrow an unknown renderNode child to an ElementNode. */
export function isElementNode(value: unknown): value is ElementNode {
	return (
		typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'element'
	);
}

/**
 * Read a prop off a child ElementNode by name, falling back to its positional
 * argument index (the parser produces `args` for positional calls and `props`
 * for named ones). Used by container renderers (Tabs, Accordion) that must
 * introspect their item nodes to build triggers, mirroring RenderNode's own
 * positional mapping.
 */
export function nodeProp<T>(node: ElementNode, key: string, index: number): T | undefined {
	const n = node as ElementNode & { props?: Record<string, unknown>; args?: unknown[] };
	return (n.props?.[key] ?? n.args?.[index]) as T | undefined;
}
