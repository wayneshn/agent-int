# Agent-to-Agent Messaging

Agent-to-agent (A2A) messaging lets one agent hand work to another agent you've allowed it to reach. Instead of one agent that does everything, you can build a fleet of specialists — an "Orchestrator" that coordinates, a "Finance" agent that holds your accounting credentials, a "CRM" agent that holds your Salesforce login — and have them delegate to each other.

The key property: **a calling agent never receives the target's credentials.** When your Orchestrator asks the Finance agent to pull an invoice, the Finance agent uses _its own_ QuickBooks credential through the [proxy](/guide/security); the Orchestrator only ever sees the text that comes back. An agent can coordinate work across services it has no secrets for.

## Letting an agent message others

Messaging is off by default. On the [agent form](/guide/agents), open the **Agent collaborators** panel and pick which of your other agents this agent may message.

- The allow-list is **one-directional** — letting A message B does not let B message A. This maps a "team lead → workers" structure where the lead dispatches but workers don't message back unless you allow it separately.
- You can only add your own agents. The three A2A tools appear for an agent only once it has at least one collaborator.

## The three tools

Once an agent has collaborators, three [built-in tools](/guide/tools) become available to it:

| Tool             | What it does                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `list_agents`    | Lists the agents this agent is allowed to message (name + description). The agent calls this first to find who it can reach. |
| `ask_agent`      | **Waits for an answer.** The target runs a full turn and its final reply comes back as the result — the calling agent pauses until then. |
| `send_to_agent`  | **Fire-and-forget.** Hands off a message and moves on immediately; the target works independently. Best for notifications and parallel fan-out. |

When an agent delegates, it can attach a short piece of **context** — a sentence or two of relevant background so the target has what it needs without being handed the whole conversation.

## What you see in chat

When an agent uses `ask_agent`, it's blocked waiting for the other agent. The chat shows a **spinner card** — _"Waiting for «Finance» to respond…"_ — with a link to open the other agent's conversation. It clears as soon as the reply arrives.

Every delegated conversation is a real thread on the target agent's side, tagged **from agent** in its thread list. These background threads are hidden from the chat sidebar by default; flip the workflow/background-thread toggle at the top of the thread list to see them.

::: tip Follow-ups stay in the same conversation
If an agent asks the same agent again within the same chat, the follow-up continues in the _same_ thread on the target's side — so the target remembers the earlier exchange and you don't have to re-explain. Starting a fresh chat starts a fresh delegated conversation.
:::

## Use cases

- **Specialist delegation** — an orchestrator with no credentials of its own coordinates a Finance agent and a CRM agent, each holding their own secrets.
- **Team-lead pattern** — a lead agent breaks a task into parts, asks worker agents to handle each, and reports the combined result back to you.
- **Parallel fan-out** — send the same request to several agents (different models, personas, or knowledge bases) and compare.
- **Reviewer / guardrail** — before sending anything externally, an agent asks a "Reviewer" agent to check the output first.

## Safety limits

A few guardrails keep delegation from running away, all enforced on the server:

- **Permission** — an agent can only message agents in its allow-list, re-checked on every call.
- **Same owner** — agents can only message other agents you own.
- **No loops** — if a delegation would form a cycle (agent A → B → A), it's refused.
- **Depth limit** — a task can only be re-delegated so many times (5 by default; see [`AGENT_MESSAGE_MAX_DEPTH`](/guide/configuration)).
- **Timeout** — a waiting `ask_agent` gives up after 20 minutes (see [`AGENT_MESSAGE_ASK_TIMEOUT_MS`](/guide/configuration)) rather than blocking forever; the other agent keeps working in its own thread.

::: warning Each agent acts with its own credentials
Delegation respects each agent's own attached [credentials](/guide/credentials) and permissions — a target agent can do anything _it_ is allowed to do, regardless of who asked. Only let an agent message agents whose capabilities you're comfortable it can trigger.
:::
