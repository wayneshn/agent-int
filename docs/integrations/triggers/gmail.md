# Gmail App Trigger

Fire a [workflow](/guide/workflows/) when a new email arrives. Valmis **polls** the Gmail API on an interval (default every 60 seconds) and fires the workflow for each new message — so it needs nothing beyond an authorized Gmail credential. No Google Cloud Pub/Sub, no public URL, and it works on `localhost`.

|                |                                                                                      |
| -------------- | ------------------------------------------------------------------------------------ |
| **Event**      | New email received                                                                   |
| **Delivery**   | Polling (default every 60s, configurable in the builder)                             |
| **Credential** | [Gmail](/integrations/google) (OAuth2) — `gmail.readonly` is enough for the trigger  |
| **Payload**    | `{ from, to, subject, snippet, body, receivedAt, messageId, threadId, labels, raw }` |

## Prerequisites

A [Gmail credential](/integrations/google) created and authorized. The trigger only reads mail, so if a credential is used _solely_ for the trigger the `gmail.readonly` scope suffices — but the standard Gmail integration already requests enough.

## Add the trigger

1. In the workflow builder's trigger card, choose **App event**, then pick **Gmail** → **New email received**.
2. Pick your Gmail credential.
3. Optionally restrict it to a **Label** using the dropdown — it lists your Gmail labels (e.g. `INBOX`); search or pick one, or paste a label id manually. Leave blank to watch all mail.
4. Optionally adjust the **poll interval** (seconds). The minimum is 60s.
5. **Save and enable** the workflow.

That's it — there is no external setup step. When the trigger activates it records a baseline (the current time) and only fires for mail that arrives **after** it is enabled; turning it on does not replay your inbox history.

## How it works

Each poll asks the Gmail API for messages newer than the last one it saw (`q=after:<lastSeen>`), fetches the new ones, and fires one workflow run per message. A durable cursor is stored on the trigger, so:

- **No email is replayed** across restarts — the cursor survives.
- **No email is missed** — a poll after downtime picks up everything since the last check.
- **No duplicates** — messages at the exact cursor boundary are de-duplicated by id.
- A burst of mail is processed in bounded batches (a flood can't overwhelm one poll).

The tradeoff versus push delivery is latency: a new email fires the workflow within one poll interval.

## Payload

Each matching email is delivered as <code v-pre>{{trigger.payload}}</code>:

```json
{
	"from": "alice@example.com",
	"to": "you@example.com",
	"subject": "Invoice #1234",
	"snippet": "Please find attached…",
	"body": "Please find attached the invoice for…",
	"receivedAt": "2026-06-14T10:32:00.000Z",
	"messageId": "18f…",
	"threadId": "18f…",
	"labels": ["INBOX", "IMPORTANT"],
	"raw": { "…": "the original Gmail message resource" }
}
```

::: tip Read-only is enough for triggering
The Gmail integration requests full scopes for agent actions, but the trigger only reads. A credential used _solely_ for the trigger needs only `gmail.readonly`.
:::

See also: the [Google integration page](/integrations/google) for creating the credential, and the [App Triggers overview](/integrations/triggers/) for the shared lifecycle and payload model.
