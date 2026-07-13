# Chat

The chat UI is the primary way to interact with agents: real-time streaming responses, visible tool use, live cost tracking, and human-in-the-loop prompts.

## Starting a conversation

Go to **Chat** and pick an agent (each conversation belongs to exactly one agent). Conversations are organized into **threads**, listed in a sidebar next to the chat.

### Thread management

- **New thread** — start a fresh context. The previous thread may be summarized into the agent's [memory](/guide/memory#automatic-summarization) in the background.
- **Rename** — threads get an auto-generated title after your second message; you can rename them any time from the thread menu.
- **Pin** — pinned threads sort to the top of the sidebar.
- **Compact context** — summarize the conversation so far to free up context (see [Compacting context](#compacting-context)).
- **Delete** — removes the thread and its messages.
- **Workflow thread filter** — threads created by [workflow runs](/guide/workflows/) are hidden by default; a toggle in the sidebar shows them, marked with a `workflow` badge.

## What you see during a turn

As the agent works, the message area renders each part of the turn live:

| Element                      | Meaning                                                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Streaming text**           | The agent's reply, token by token, rendered as Markdown.                                                                                                                                       |
| **Thinking block**           | A collapsible section showing the model's reasoning, when the model emits it. Collapsed by default.                                                                                            |
| **Tool call**                | An expandable block per tool invocation showing the tool name and icon, its arguments (JSON), and — once finished — the result. Calls to `call_api` show the icon of the credential's service. |
| **Human-in-the-loop prompt** | An highlighted card when the agent asks you something mid-task (see below).                                                                                                                    |
| **Images**                   | Image content renders as thumbnails with a click-to-enlarge lightbox.                                                                                                                          |

The full record — including tool calls and results — is persisted, so reloading the page reproduces the entire conversation.

## The usage bar

Above the input sits a usage bar (toggleable) showing:

- **Context fill** — how much of the model's context window the conversation currently occupies, based on the actual token counts of the thread and the model's context length from the catalog.
- **Session cost** — cumulative USD cost of the thread, updated after every turn from the model's per-token pricing.

## Compacting context

A long conversation grows the context sent to the model on every turn — raising cost and eventually filling the model's context window. **Compacting** summarizes the conversation so far and replaces it — *for the model only* — with that summary, so the next turn starts from a much smaller context.

Compaction is **manual and non-destructive**:

- Your visible chat history stays exactly as it was, with a **Context compacted** divider marking the point. Only what the agent receives going forward is shortened to the summary plus anything sent after it.
- Trigger it from the **Compact** button on the usage bar, or **Compact context** in the thread menu. The context-fill portion of the usage bar drops right away, then grows again as the conversation continues.
- On [Telegram and Discord](/guide/channels), the `/compact` command does the same for the active session.

The agent keeps working with the summary in place of the earlier turns, so it retains the important facts and decisions without re-reading the whole history. You can't compact while a turn is running — wait for it to finish.

## Human-in-the-loop (HITL)

Agents can pause mid-task to ask you a question using their `ask_human` tool. When that happens:

1. A prompt card appears in the chat with the agent's question — and, when the agent provided them, quick-reply options.
2. The input unlocks so you can answer.
3. The agent waits for your reply and then continues the same turn with your answer.

The agent waits up to **35 minutes** for a response; after that the request times out and the agent continues without an answer. HITL prompts also work on [Telegram and Discord](/guide/channels), where options arrive as tappable buttons.

## Concurrency

One turn runs at a time per thread — sending a message while the agent is still working is rejected until the current turn finishes.
