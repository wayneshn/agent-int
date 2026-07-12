import type { AppTriggerEventInfo, AppTriggerState } from '@repo/types';
import {
	readErrorExcerpt,
	type AppTriggerPollResult,
	type AppTriggerProvider,
	type AppTriggerProviderContext,
	type NormalizedAppEvent,
} from '../AppTriggerProvider.js';

const FORMS_API_BASE = 'https://forms.googleapis.com/v1';

interface FormsAnswer {
	questionId: string;
	textAnswers?: { answers?: { value?: string }[] };
}

interface FormsResponse {
	responseId: string;
	createTime?: string;
	lastSubmittedTime?: string;
	answers?: Record<string, FormsAnswer>;
}

interface FormsResponseList {
	responses?: FormsResponse[];
	nextPageToken?: string;
}

/**
 * Google Forms app trigger — polls the Forms API for new responses.
 *
 * Google Forms has no simple native push (it would need an Apps Script installable
 * trigger), so it polls `forms.responses.list` filtered by submission time. The cursor
 * is the latest submission timestamp seen.
 */
export class GoogleFormsTriggerProvider implements AppTriggerProvider {
	readonly id = 'google-forms';
	readonly displayName = 'Google Forms';
	readonly icon = '/logos/google-forms.svg';
	readonly compatibleCredentialTypes = ['google-forms'];
	readonly deliveryMode = 'poll' as const;
	readonly minPollIntervalSec = 60;
	readonly setupNote =
		'Requires a Google Forms credential with the forms.responses.readonly scope. ' +
		'The connected account must have edit/read access to the target form.';

	listEvents(): AppTriggerEventInfo[] {
		return [
			{
				id: 'response.created',
				name: 'New form response',
				description: 'Fires when a new response is submitted to the form.',
				params: [
					{
						name: 'formId',
						label: 'Form ID',
						type: 'string',
						required: true,
						description:
							'The form id from its edit URL: docs.google.com/forms/d/<FORM_ID>/edit',
						placeholder: '1FAIpQLSc...',
					},
				],
				payloadShape:
					'{ formId, responseId, submittedAt, answers: { <questionId>: string[] }, raw }',
			},
		];
	}

	async poll(
		ctx: AppTriggerProviderContext,
		_eventId: string,
		params: Record<string, unknown>,
		state: AppTriggerState,
	): Promise<AppTriggerPollResult> {
		const formId = this.requireFormId(params);
		const cursor = typeof state.cursor === 'string' ? state.cursor : undefined;

		const responses = await this.fetchResponses(ctx, formId, cursor);

		// Determine the newest submission time for the next cursor.
		let newest = cursor ?? '';
		for (const r of responses) {
			const ts = r.lastSubmittedTime ?? r.createTime ?? '';
			if (ts > newest) newest = ts;
		}

		// First run: establish a baseline without replaying historical responses.
		if (cursor === undefined) {
			return { events: [], stateUpdate: { cursor: newest, lastPolledAt: new Date().toISOString() } };
		}

		const events: NormalizedAppEvent[] = responses
			.filter((r) => (r.lastSubmittedTime ?? r.createTime ?? '') > cursor)
			.map((r) => this.normalize(formId, r));

		return {
			events,
			stateUpdate: { cursor: newest || cursor, lastPolledAt: new Date().toISOString() },
		};
	}

	private async fetchResponses(
		ctx: AppTriggerProviderContext,
		formId: string,
		cursor: string | undefined,
	): Promise<FormsResponse[]> {
		const qs: Record<string, string> = { pageSize: '100' };
		// The Forms API accepts a `filter` of the form `timestamp >= <RFC3339>`.
		if (cursor) qs.filter = `timestamp >= ${cursor}`;

		const url = `${FORMS_API_BASE}/forms/${encodeURIComponent(formId)}/responses`;
		const response = await ctx.execute({ method: 'GET', url, qs });
		if (!response.ok) {
			const excerpt = await readErrorExcerpt(response);
			throw new Error(`Google Forms responses.list failed (${response.status}): ${excerpt}`);
		}
		const body = (await response.json()) as FormsResponseList;
		return body.responses ?? [];
	}

	private normalize(formId: string, response: FormsResponse): NormalizedAppEvent {
		const answers: Record<string, string[]> = {};
		for (const [questionId, answer] of Object.entries(response.answers ?? {})) {
			const values = answer.textAnswers?.answers?.map((a) => a.value ?? '') ?? [];
			answers[questionId] = values;
		}
		const submittedAt = response.lastSubmittedTime ?? response.createTime;
		return {
			id: response.responseId,
			occurredAt: submittedAt,
			payload: {
				formId,
				responseId: response.responseId,
				submittedAt,
				answers,
				raw: response,
			},
		};
	}

	private requireFormId(params: Record<string, unknown>): string {
		const formId = params.formId;
		if (typeof formId !== 'string' || formId.trim() === '') {
			throw new Error('Google Forms trigger requires a "formId" parameter');
		}
		// Form ids are URL-safe tokens; reject anything that could escape the path.
		if (!/^[A-Za-z0-9_-]+$/.test(formId)) {
			throw new Error(`Invalid Google Forms formId: ${formId}`);
		}
		return formId;
	}
}
