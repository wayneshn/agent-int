import { accentChartVar, chartPalette, type ChatUiAccent } from '@repo/openui';

export interface ChartSeriesInput {
	name: string;
	data: number[];
}

export interface ChartRow {
	label: string;
	[seriesName: string]: string | number;
}

/** Charts render at most 5 series — the palette has 5 fixed slots. */
export const MAX_CHART_SERIES = 5;

/**
 * Transform the schema's {labels, series} shape into LayerChart row objects:
 * [{ label: 'Jan', Revenue: 14.1, Costs: 9 }, …]. Missing points become 0.
 */
export function toChartRows(
	labels: string[] | undefined,
	series: ChartSeriesInput[] | undefined
): ChartRow[] {
	const capped = (series ?? []).slice(0, MAX_CHART_SERIES);
	return (labels ?? []).map((label, i) => {
		const row: ChartRow = { label };
		for (const s of capped) {
			row[s.name] = s.data?.[i] ?? 0;
		}
		return row;
	});
}

/**
 * LayerChart series descriptors with palette colors. Color follows the series'
 * fixed slot (never re-assigned when series count changes); a single series
 * takes the requested accent hue, multi-series always starts at slot 1.
 */
export function toChartSeries(
	series: ChartSeriesInput[] | undefined,
	accent?: ChatUiAccent
): { key: string; color: string }[] {
	const capped = (series ?? []).slice(0, MAX_CHART_SERIES);
	if (capped.length === 1) {
		return [{ key: capped[0].name, color: accentChartVar(accent) }];
	}
	const palette = chartPalette();
	return capped.map((s, i) => ({ key: s.name, color: palette[i] }));
}
