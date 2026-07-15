# Outlook / Hotmail App Trigger

Fire a [workflow](/guide/workflows/) when a new email arrives in an Outlook.com, Hotmail, or Microsoft 365 mailbox. Like the [Gmail trigger](/integrations/triggers/gmail), Valmis **polls** the Microsoft Graph mail API on an interval (default every 60 seconds) — nothing beyond an authorized Microsoft Outlook credential is required, and it works on `localhost`.

|                |                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------- |
| **Event**      | New email received                                                                          |
| **Delivery**   | Polling (default every 60s, configurable in the builder)                                    |
| **Credential** | [Microsoft Outlook](/integrations/microsoft-outlook) (OAuth2) — needs the `Mail.Read` scope |
| **Payload**    | `{ from, to, subject, snippet, body, receivedAt, messageId, threadId, labels, raw }`        |

Outlook.com, Hotmail, and Live mailboxes all use the same Microsoft Graph API, so this one trigger covers all of them through a Microsoft Outlook credential.

## Prerequisites

A Microsoft Outlook credential created and authorized. The default scopes include `Mail.Read`, which is all the trigger needs.

## Add the trigger

1. In the workflow builder's trigger card, choose **App event**, then pick **Outlook / Hotmail** → **New email received**.
2. Pick your Microsoft Outlook credential.
3. Optionally set a **Mail folder** — a well-known name (`inbox`, `junkemail`, …) or a folder id. Defaults to `inbox`.
4. Optionally adjust the **poll interval** (seconds). The minimum is 60s.
5. **Save and enable** the workflow.

There is no external setup step. When the trigger activates it records a baseline (the current time) and only fires for mail arriving **after** it is enabled — it does not replay existing mail.

## How it works

Each poll asks Microsoft Graph for messages received at-or-after the last one it saw (`$filter=receivedDateTime ge <lastSeen>`), fetches the new ones, and fires one workflow run per message. A durable cursor on the trigger guarantees no replay across restarts, no missed mail after downtime, and no duplicates at the cursor boundary. New mail fires the workflow within one poll interval.

## Payload

Each matching email is delivered as <code v-pre>{{trigger.payload}}</code>:

```json
{
	"from": "alice@example.com",
	"to": "you@example.com",
	"subject": "Invoice #1234",
	"snippet": "Please find attached…",
	"body": "<html>…the message body…</html>",
	"receivedAt": "2026-06-14T10:32:00Z",
	"messageId": "AAMk…",
	"threadId": "AAQk…",
	"labels": ["Work"],
	"raw": { "…": "the original Microsoft Graph message resource" }
}
```

See also: the [App Triggers overview](/integrations/triggers/) for the shared lifecycle and payload model.
