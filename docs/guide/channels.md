# Messaging Channels

Channels let you talk to an agent from a messaging app instead of the web UI. You bring your own bot — created with the platform's official tooling — and pair it with an agent. Currently supported:

- **Telegram** — via a bot created with @BotFather ([setup](/integrations/telegram-bot))
- **Discord** — via a bot application with direct messages ([setup](/integrations/discord-bot))

::: info WhatsApp
WhatsApp appears in the channel picker but is not yet functional — there is no WhatsApp credential type or message adapter in the current release.
:::

Conversations happen in **direct messages** with your bot. Streaming responses are accumulated and delivered as complete messages; long replies are split automatically to fit each platform's message limits.

## Connecting a channel

Channels are managed under **Account → Channels**.

### 1. Create the bot credential

First create a credential for your bot under [Credentials](/guide/credentials):

- Telegram: a **Telegram Bot** credential (bot token + username from @BotFather)
- Discord: a **Discord Bot** credential (bot token from the Discord Developer Portal, with the _Message Content_ intent enabled)

The integration pages linked above walk through getting these step by step.

### 2. Generate a pairing code

Click **Connect channel** and pick:

1. The **channel** (Telegram or Discord)
2. The **agent** that should answer
3. The **bot credential** from step 1

You receive a **pairing code** — valid for 10 minutes, single use.

### 3. Pair from the messaging app

Open a DM with your bot and send:

```
/pair <CODE>
```

The bot confirms, and the channel card in the UI switches to **Paired**. From now on, any message you DM the bot goes to the paired agent.

## Bot commands

The bots understand a common command set:

| Command             | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `/start`, `/help`   | Introduction and command list                             |
| `/pair <CODE>`      | Pair this chat with an agent using a code from the web UI |
| `/unpair`           | Remove the pairing                                        |
| `/agents`           | List your agents                                          |
| `/use <agent>`      | Switch which agent answers in this chat                   |
| `/new`              | Start a new session (fresh conversation context)          |
| `/sessions`         | List your 10 most recent sessions                         |
| `/session <number>` | Switch back to a listed session                           |
| `/status`           | Show the current pairing and session                      |
| `/compact`          | Summarize and shrink the current session's context        |

## Channel settings

Each connected channel card offers:

| Setting                | Description                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Thread mode**        | **Persistent** — all messages continue one long-running conversation. **Per session** — conversations are split into sessions; `/new` starts a fresh one. |
| **Tool notifications** | When on, the bot sends a short notice each time the agent uses a tool, so you can follow along on long tasks.                                             |
| **Disconnect**         | Removes the pairing (with confirmation).                                                                                                                  |

## Human-in-the-loop on channels

When the agent asks a question mid-task ([`ask_human`](/guide/tools#human-interaction)), the bot sends it to you in the DM — with the agent's answer options as tappable buttons (inline keyboard on Telegram, message buttons on Discord). Tap one or type a free-form reply; the agent continues with your answer.

## Privacy notes

- Pairing codes are random, single-use, and expire after 10 minutes; repeated failed `/pair` attempts are rate-limited.
- The bot only responds in direct messages — on Discord, messages in servers (guilds) are ignored.
- Both bots run **outbound** connections from your server (Telegram long polling, Discord gateway) — no inbound webhook or public endpoint is required for channels.
