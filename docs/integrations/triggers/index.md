# App Triggers

App triggers fire a [workflow](/guide/workflows/) shortly after something happens in a connected app — a new email arrives, a Notion database item changes, a new Google Form response is submitted, a Slack message is posted. Unlike a [generic webhook](/guide/workflows/triggers#webhook) (where you wire and parse everything yourself), each app is a built-in **provider** that knows how to listen for its events and hand the workflow a clean, documented payload.

## Available triggers

| App                                                     | Event                            | Delivery              | Extra setup                                      |
| ------------------------------------------------------- | -------------------------------- | --------------------- | ------------------------------------------------ |
| [Gmail](/integrations/triggers/gmail)                   | New email received               | Polling               | None beyond the credential                       |
| [Outlook / Hotmail](/integrations/triggers/outlook)     | New email received               | Polling               | None beyond the credential                       |
| [Google Forms](/integrations/triggers/google-forms)     | New form response                | Polling               | None beyond the credential                       |
| [Notion](/integrations/triggers/notion)                 | Database item created or updated | Push (Notion webhook) | Add the delivery URL in your Notion integration  |
| [Slack](/integrations/triggers/slack)                   | New message                      | Push (Events API)     | Auto-register via Manifest API, or paste the URL |

Each trigger uses one of your [credentials](/guide/credentials) of the matching type. The credential authenticates the _listener_, so any credential of the right type works — it need not be attached to the agent that owns the workflow.

## How it works

A provider abstracts away the two ways apps deliver events:

- **Polling.** Valmis asks the app for new items on an interval (default every 60s, configurable in the builder). Email providers (Gmail, Outlook/Hotmail) and Google Forms are polled — this needs nothing beyond the credential and works on `localhost`. New items fire the workflow within one poll interval.
- **Push (webhook).** The app calls Valmis when something happens. Notion and Slack post directly to a delivery URL. Push triggers are near-instant but need the delivery URL registered with the app.

Whatever the mechanism, each event becomes **one workflow run**, and the provider maps the raw event to **normalized fields plus a `raw` escape hatch** (the original API object) delivered as <code v-pre>{{trigger.payload}}</code>. Use the normalized fields for clean instructions and reach into `raw` only when you need something the normalization didn't surface.

| App                   | <code v-pre>{{trigger.payload}}</code> shape                                                 |
| --------------------- | -------------------------------------------------------------------------------------------- |
| **Gmail**             | `{ from, to, subject, snippet, body, receivedAt, messageId, threadId, labels, raw }`         |
| **Outlook / Hotmail** | `{ from, to, subject, snippet, body, receivedAt, messageId, threadId, labels, raw }`         |
| **Notion**            | `{ pageId, databaseId, url, properties, changedProperties, lastEditedTime, eventType, raw }` |
| **Slack**             | `{ channel, user, text, ts, eventType, raw }`                                                |
| **Google Forms**      | `{ formId, responseId, submittedAt, answers, raw }`                                          |

## Adding an app trigger

In the workflow builder's trigger card, choose **App event**, then pick:

1. **App** — the provider (Gmail, Outlook/Hotmail, Google Forms, Notion, Slack).
2. **Credential** — a credential of the matching type. See the per-app page for which credential and scopes it needs.
3. **Event** — what to fire on (e.g. _New email received_).
4. **Parameters** — event-specific fields. Where the app supports it, these are **searchable dropdowns** populated live from your account using the selected credential: pick a Gmail label, one or more Notion databases, or one or more Slack channels by name instead of pasting ids. Each dropdown also accepts a manually typed id as a fallback. (Google Forms is the exception — the Forms API can't list a user's forms, so you enter the form id directly.)

The **polling** apps (Gmail, Outlook/Hotmail, Google Forms) need no external setup — just save and enable. For the **push** apps (Notion, Slack), **save the workflow first** — the builder then reveals the **delivery URL** (`<APP_URL>/api/v1/webhooks/<triggerId>`) to register with the app. Where the app has an API for it (Slack's Manifest API), Valmis registers it for you; otherwise you paste the URL once. Each provider's page has the exact steps.

## Delivery & security

- **Polling apps** (Gmail, Outlook/Hotmail, Google Forms) call the app's API with your authorized credential — there is no inbound endpoint to secure. A durable cursor makes each poll cheap and prevents replayed or duplicated events.
- **Push apps** verify their **own** inbound requests, so the delivery URL is safe to hand to the external service:
  - **Slack** — verifies the **signing secret** (HMAC over the raw request body).
  - **Notion** — verifies the **`X-Notion-Signature`** (HMAC with the verification token captured during setup).

::: tip First run won't replay history
Polling apps (Gmail, Outlook/Hotmail, Google Forms) record a baseline on activation and only fire for items that arrive **after** the trigger is enabled — turning a trigger on does not flood you with every past email or response.
:::

::: warning Auto-disable on repeated failure
Like cron triggers, an app trigger that fails to listen 5 times in a row (e.g. an expired credential or a revoked subscription) is automatically disabled. Fix the cause and re-enable the workflow.
:::

## Lifecycle

Listeners are managed for you across the workflow's life:

- **Enable / save** — polling starts (or the push subscription is registered).
- **Disable / pause** — polling stops (or the push subscription is unregistered) and timers are cleared.
- **Delete** — the listener is removed and all state cleaned up.
- **Delete the credential** — every app trigger using it is stopped.

## Registration status

Registration status applies only to **push** triggers (Notion, Slack). Polling triggers (Gmail, Outlook/Hotmail, Google Forms) have no subscription to register — they just start polling on save. After you save a push trigger, the builder shows one of three states inline:

- **✓ Registered automatically** (green) — Valmis created the subscription through the app's API. Only **Slack with a config token** reaches this state.
- **⚠ Manual setup required** (amber) — the app has no create-webhook API (or the needed credentials aren't set), so you must add the **delivery URL** in the app yourself. This is normal for **Notion** (always) and **Slack without a config token**. The delivery URL is shown right above the status.
- **⚠ Setup failed** (red) — registration was attempted but errored (e.g. an expired credential, a non-HTTPS `APP_URL`, or missing scopes). The message says why.

Use the **Re-check registration** button (shown in edit mode) to re-attempt registration and refresh the status after you've completed manual setup or fixed the cause — no need to re-save the whole workflow.

To confirm from the server side, grep the backend logs for `[app-trigger]`:

- `[app-trigger] webhook registered` — auto-registration succeeded.
- `[app-trigger] Slack manifest auto-register skipped (no appId/configToken) — manual setup` — Slack is in manual mode.
- `[app-trigger] Notion webhook is configured in the integration settings (no API auto-register)` — Notion is in manual mode (always).
- `[app-trigger] webhook registration failed` — registration errored (the line includes the reason).

## Testing locally (tunneling)

Polling triggers (Gmail, Outlook/Hotmail, Google Forms) need **no** tunneling — they call the app's API outbound, so they work as-is on `localhost`.

Only the **push** apps (Slack, Notion) must reach Valmis over the **public internet via HTTPS**. Their delivery URL is built from `APP_URL` (default `http://localhost:3000`), which an external service **cannot** reach — and Slack/Notion reject non-HTTPS URLs. To test a push trigger on your machine, expose the app through a tunnel:

1. Start a tunnel to your running app (port `3000` by default):

   ```sh
   ngrok http 3000
   # or
   cloudflared tunnel --url http://localhost:3000
   ```

2. Set `APP_URL` to the tunnel's HTTPS host and **restart the backend** so new delivery URLs use it:

   ```sh
   APP_URL=https://<your-tunnel-host>
   ```

3. Save (or re-save) the workflow. The delivery URL is now `https://<your-tunnel-host>/api/v1/webhooks/<triggerId>` — reachable by the external app.

4. Complete any **manual setup** (Notion always; Slack without a config token) by pasting that URL into the app, then click **Re-check registration**.

::: tip Inbound requests are verified, not authenticated
The delivery URL needs no API key — it's intentionally public so apps can POST to it. Security comes from the unguessable `triggerId` plus each provider verifying every delivery cryptographically (Slack signing secret, Notion `X-Notion-Signature`). Unverified or unknown requests get a generic `401`.
:::
