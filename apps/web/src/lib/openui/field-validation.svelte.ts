import { getFormValidation, parseRules } from '@openuidev/svelte-lang';
import type { ParsedRule } from '@openuidev/svelte-lang';

export interface FieldValidation {
	/** Current validation error for this field (reactive — call in templates). */
	error: () => string | undefined;
	/** Validate the field now (call on blur / discrete change). */
	validateNow: (value: unknown) => void;
	/** Clear the field's error (call while the user is still typing). */
	clearError: () => void;
}

/**
 * Wire a form field into the svelte-lang Form validation context.
 *
 * Must be called during component init (uses getContext + $effect). Fields
 * without rules — or rendered outside a Form — get inert no-ops so callers
 * don't need to branch.
 *
 * @param getName  Reactive getter for the field name prop
 * @param getRules Reactive getter for the rules prop (string[] like ["required", "email"])
 * @param getValue Reactive getter for the field's current value
 */
export function setupFieldValidation(
	getName: () => string,
	getRules: () => string[] | undefined,
	getValue: () => unknown
): FieldValidation {
	const validation = getFormValidation();
	const parsedRules = (): ParsedRule[] => parseRules(getRules() ?? []);

	$effect(() => {
		const rules = parsedRules();
		if (!validation || rules.length === 0) return;
		const name = getName();
		validation.registerField(name, rules, getValue);
		return () => validation.unregisterField(name);
	});

	return {
		error: () => validation?.errors[getName()],
		validateNow: (value: unknown) => {
			const rules = parsedRules();
			if (validation && rules.length > 0) validation.validateField(getName(), value, rules);
		},
		clearError: () => validation?.clearFieldError(getName())
	};
}
