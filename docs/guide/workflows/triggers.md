# Triggers

Every workflow has exactly one trigger, set on the **Trigger** node — click it to open the trigger panel and choose a **Trigger type**: Manual, Scheduled (Cron), Webhook, or App event.

## Manual

The default — the workflow only runs when something starts it. Today that's the agent itself: ask it in chat to run the workflow and it fires it with the <code v-pre>trigger_workflow</code> tool (see [Managing workflows from chat](/guide/workflows/agent-chat)). The other trigger types below fire on their own. Manual triggers have nothing to configure.

## Cron

Runs on a schedule. Set a **cron expression** (a schedule picker helps you build one) and an optional **timezone** — an IANA name like `America/New_York` (defaults to `UTC`).

```
0 9 * * 1-5   # 09:00 every weekday
```

::: warning Auto-disable on repeated failure
A cron trigger that fails 5 times in a row is automatically disabled to stop silent error loops. Re-enable the workflow after fixing the cause.
:::

## Webhook

Gives the workflow an HTTP endpoint. A **URL** and an **HMAC secret** are generated when you first save the workflow — the trigger card then shows both with copy buttons. The JSON request body and headers arrive as <code v-pre>{{trigger.payload}}</code> (as `body` and `headers`).

By default, callers must sign requests with HMAC-SHA256 over the raw body, in the `X-Hub-Signature-256` header:

```sh
SIGNATURE=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST "$WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=$SIGNATURE" \
  -d "$BODY"
```

A successful delivery returns `202 Accepted` with the started run's id:

```json
{ "success": true, "data": { "received": true, "runId": "…", "workflowId": "…" } }
```

Rejected requests return `401` (unknown trigger, disabled workflow, or bad signature), `400` for a non-JSON body, and `503` if the runtime couldn't start (safe to retry).

If the calling service can't sign requests, turn off **Require signed requests** in the trigger card. The endpoint then accepts any request to the URL.

::: warning Unsigned webhooks
With signature verification off, anyone who knows the webhook URL can trigger the workflow. Treat the URL itself as a secret.
:::

## App event

Runs the workflow when something happens in a connected app — a new Gmail message, a Notion database change, a new Google Form response, a Slack message. Each app is a built-in **provider** that listens for its events and hands the workflow a clean, normalized <code v-pre>{{trigger.payload}}</code>.

In the trigger card, choose **App event**, then pick:

1. **App** — the provider (Gmail, Outlook/Hotmail, Google Forms, Notion, Slack).
2. **Credential** — one of your credentials of the matching type. It authenticates the _listener_, so any credential of the right type works — it need not be attached to this agent.
3. **Event** — what to fire on (e.g. _New email received_).
4. **Parameters** — event-specific fields (a Gmail label, an Outlook folder, a Notion database, a Slack channel, a Google Form id). Where the app supports it these are searchable dropdowns; otherwise you type the id.

**Polling** apps (Gmail, Outlook/Hotmail, Google Forms) need no external setup — just save and enable. For **push** apps (Notion, Slack), save the workflow first — the card then reveals a **delivery URL** to register with the app and shows the registration status. Each event becomes one run.

Per-app setup, payload shapes, and delivery details live in the **[App Triggers reference](/integrations/triggers/)**: [Gmail](/integrations/triggers/gmail), [Outlook / Hotmail](/integrations/triggers/outlook), [Google Forms](/integrations/triggers/google-forms), [Notion](/integrations/triggers/notion), [Slack](/integrations/triggers/slack).

::: warning Auto-disable on repeated failure
Like cron triggers, an app trigger that fails to listen 5 times in a row (e.g. an expired credential) is automatically disabled. Fix the cause and re-enable the workflow.
:::
