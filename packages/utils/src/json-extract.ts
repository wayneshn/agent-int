/**
 * Robust JSON extraction from LLM output.
 *
 * Models asked to return JSON frequently wrap it in narration ("The script ran
 * successfully. Now I'll output the result: [{…}]") or in a markdown code fence
 * (```json … ```). A strict `JSON.parse` on that raw text throws. This helper
 * recovers the JSON value deterministically, without a second LLM round-trip.
 *
 * Strategy, first success wins:
 *   1. Strip a leading ```json / ``` fence and a trailing ``` fence, then parse.
 *   2. Parse the whole trimmed text directly (pure-JSON responses).
 *   3. Scan for the first `{` or `[` and string/escape-aware balanced-match it to
 *      its close, then parse that slice. Handles "prose … {json}" / "prose … [json]"
 *      and root-level arrays as well as objects.
 *
 * Returns the parsed value, or null when no JSON value can be recovered. Never throws.
 */
export function extractJsonValue(text: string): unknown | null {
	if (typeof text !== 'string') return null;
	const trimmed = text.trim();
	if (!trimmed) return null;

	// 1 + 2 — fence-stripped parse, then whole-text parse.
	const unfenced = trimmed
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '')
		.trim();
	for (const candidate of [unfenced, trimmed]) {
		const direct = tryParse(candidate);
		if (direct.ok) return direct.value;
	}

	// 3 — balanced-bracket scan from the first opener in the (fence-stripped) text.
	for (const candidate of [unfenced, trimmed]) {
		const sliced = extractBalanced(candidate);
		if (sliced !== null) {
			const parsed = tryParse(sliced);
			if (parsed.ok) return parsed.value;
		}
	}
	return null;
}

/** JSON.parse that reports success/failure instead of throwing (a valid `null` still counts as ok). */
function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(s) };
	} catch {
		return { ok: false };
	}
}

/**
 * Return the substring spanning the first top-level `{…}` or `[…]` in `s`, matched
 * with string/escape awareness so braces inside string literals don't shift the depth.
 * Only the chosen bracket type is counted, so nested brackets of the other kind
 * (e.g. an array inside an object) are handled naturally. Null when no complete value.
 */
function extractBalanced(s: string): string | null {
	const objIdx = s.indexOf('{');
	const arrIdx = s.indexOf('[');
	let start: number;
	let open: string;
	if (objIdx === -1 && arrIdx === -1) return null;
	if (arrIdx === -1 || (objIdx !== -1 && objIdx < arrIdx)) {
		start = objIdx;
		open = '{';
	} else {
		start = arrIdx;
		open = '[';
	}
	const close = open === '{' ? '}' : ']';

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < s.length; i++) {
		const ch = s[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return s.slice(start, i + 1);
		}
	}
	return null;
}
