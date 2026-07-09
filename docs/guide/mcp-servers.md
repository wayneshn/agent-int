# MCP Servers

**MCP (Model Context Protocol)** is an open standard for giving AI agents new tools. An MCP server publishes a set of tools — search a wiki, query a database, create a ticket, run a report — and any MCP-compatible app can connect to it and use them. Valmis is an MCP **client**: you register a server once under **MCP Servers**, choose which of its tools to expose, and attach it to your agents.

This is how you extend an agent beyond the [built-in tools](/guide/tools) and the [100+ credential integrations](/integrations/): if a service ships an MCP server, your agents can use it without waiting for a native integration.

::: tip MCP vs. Credentials
A [credential](/guide/credentials) lets an agent call a REST API through the generic `call_api` tool — you (or the model) still figure out the endpoints. An **MCP server** hands the agent ready-made, purpose-built tools with names and descriptions. When a service offers both, MCP is usually the smoother experience.
:::

## Requirements

An agent can use MCP tools only when its [**Allow internet access**](/guide/agents#allow-internet-access) toggle is **On**. MCP servers live outside your deployment, so an agent that is meant to be network-isolated cannot reach them. This is enforced on the server for every call, not just hidden in the UI.

No administrator configuration is needed — there is no feature flag to enable.

## Adding a server

Open **MCP Servers → Add server**. You have two ways to add one.

### By URL

Point Valmis at a running MCP server:

| Field              | What to enter                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| **Name**           | A label for your list (e.g. `Notion`, `Company Wiki`).                                                    |
| **Server URL**     | The server's endpoint, e.g. `https://mcp.example.com/mcp`. See [Finding the URL](#finding-the-right-url). |
| **Transport**      | **Streamable HTTP** (the modern default) or **SSE** (legacy). Pick what the server documents.             |
| **Authentication** | **None** for open servers, or **Header / token** to send an auth header (see below).                      |

For **Header / token** auth, add one or more headers — most commonly `Authorization` with a value like `Bearer <your-token>`. Header values are [encrypted at rest](#how-it-works-and-why-it-s-safe) and never sent to the agent.

### Paste JSON

If you already have a server's config from another app (Claude Desktop, Cursor, VS Code, or a marketplace listing), switch to the **Paste JSON** tab and paste the standard `mcpServers` object:

```json
{
	"mcpServers": {
		"example": {
			"url": "https://mcp.example.com/mcp",
			"headers": { "Authorization": "Bearer sk-…" }
		}
	}
}
```

Valmis accepts both the `mcpServers` key and VS Code's `servers` key, and imports every entry at once. Remote (URL) servers are ready to test immediately.

## Finding the right URL

Many hosted servers expose their MCP endpoint on a **path**, not at the domain root — commonly `/mcp` for Streamable HTTP and `/sse` for SSE. If you have the base URL but the exact endpoint isn't documented, enter it anyway: when a connection fails, Valmis automatically retries the same transport against the conventional path (`…/mcp` or `…/sse`). If your URL already includes the path, it's used as-is.

::: tip
If a test fails, the error message shows exactly what the server said — including hints like _"Use POST /mcp for streamable HTTP"_. Follow that and update the URL.
:::

## Testing and choosing tools

Adding a server doesn't connect to it yet. Open a server and click **Test connection**: Valmis connects, discovers the server's tools, and lists them. Each tool has an on/off switch.

::: warning Keep the enabled list focused
Every **enabled** tool is sent to the model on **every** turn of a conversation, which adds to token cost and can crowd the model's attention. Turn off tools an agent doesn't need. A server with 40 tools where you only need 3 should have 3 enabled.
:::

The panel also shows the server's connection **status** and, if a test failed, the exact error so you can fix the URL or token.

## Attaching a server to an agent

A server does nothing until you attach it to an agent. On the [agent form](/guide/agents), open the **MCP servers** panel, add the servers this agent should use, and save. The agent gains that server's currently-enabled tools.

Attach only what each agent needs — the set of attached servers and enabled tools defines what a misbehaving or manipulated agent can reach. Detaching a server takes effect immediately, even for a run already in progress. Deleting a server detaches it from all agents automatically.

## Using MCP tools in chat

You don't call MCP tools yourself — the model decides when to use them as it works on your request, exactly like [built-in tools](/guide/tools). Each call appears inline in [chat](/guide/chat) with a plug icon and a readable label such as **Notion · search**, and you can expand it to see the arguments and result.

Under the hood each tool is named `mcp__<server>__<tool>` so tools from different servers never collide.

## What's supported

- Remote **Streamable HTTP** servers
- Remote **SSE** (legacy) servers
- **No-auth** and **header/token** authentication
- Marketplace `mcpServers` JSON import

::: info Remote vs. installable servers
Some servers are **hosted** and you connect by URL — those work currently. Others are distributed as **installable packages** (`npx`/`uvx`/Docker) that a client launches locally; their configs use `command` and `args` instead of a `url`. Valmis stores those entries but can't run them yet.
:::

## How it works (and why it's safe)

- **The connection lives on the server, not in the agent.** Valmis holds the live MCP connection and injects your token host-side. The agent's [sandbox](/guide/security) only ever sends "run this tool with these arguments" and receives the result — it never sees the server URL's secrets or your auth token.
- **Secrets are encrypted at rest.** Auth headers and tokens are encrypted with AES-256-GCM using your `CREDENTIAL_ENCRYPTION_KEY`, the same as [credentials](/guide/credentials#security-properties). Editing a server shows secret fields as redacted placeholders; submitting without touching them keeps the stored value.
- **Every call is re-checked live.** On each tool call the platform confirms the server is still yours, still enabled, still attached to that agent, and that the specific tool is enabled — so detaching a server or disabling a tool takes effect immediately.
- **Private addresses are blocked.** A server URL that resolves to a loopback, link-local, or private network address is refused, to prevent an agent from reaching internal services.
- **Gated on internet access.** MCP tools are offered only to agents with internet access on, checked on the server for every call.

## Good to know

- **Enabled tools cost tokens.** See the warning above — trim the list per server, and use the agent panel to attach only the servers an agent needs.
- **Tools can change.** If a server adds or renames tools, click **Test connection** again to refresh the list. Newly discovered tools default to enabled.
- **Errors are shown, not hidden.** A failed test surfaces the server's actual response (status code and message), so you can tell an auth problem (401/403) from a wrong URL.

## Troubleshooting

| Symptom                                               | Likely cause & fix                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **401 Unauthorized**                                  | The server needs a token, or the token is wrong. Add or correct the **Authorization** header on the server.              |
| **403 Forbidden**                                     | The token is valid but lacks the required scope/permission for this server.                                              |
| **"Unsupported endpoint. Use POST /mcp…"** (or a 404) | The URL points at the wrong path. Use the endpoint the message names, e.g. add `/mcp` (Streamable HTTP) or `/sse` (SSE). |
| Status shows **needs auth**                           | The server uses OAuth, which isn't supported yet. Use a server that accepts a static token, if available.                |
| **"resolves to a private/loopback address"**          | The URL isn't a public address. MCP servers must be reachable on the public internet.                                    |
| The agent never uses a tool                           | Check the tool is enabled on the server, the server is attached to the agent, and the agent's **internet access** is on. |

## Learn more

- [Model Context Protocol — official site](https://modelcontextprotocol.io)
- [Built-in Tools](/guide/tools) · [Credentials](/guide/credentials) · [Security Overview](/guide/security)
