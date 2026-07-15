# Built-in Tools

Every agent has the same core set of built-in tools. The model decides when to call them; each call and its result is shown inline in [chat](/guide/chat) and recorded in workflow step logs. You don't enable tools individually on an agent — capability is governed by what you attach (credentials, embedding model), whether the agent has internet access and the [web browser](/guide/browser) is enabled, and, in workflows, by per-step tool allowlists.

## External APIs

### `call_api`

Makes an HTTP request to an external service. When the agent passes one of its attached [credentials](/guide/credentials), the platform injects the secret server-side — the sandbox never sees it. Without a credential, the agent can call public, unauthenticated APIs.

Mid-conversation revocation is enforced: if you detach a credential from an agent while it's running, subsequent calls with it are rejected.

**Binary files.** The agent can upload and download binary data (PDFs, images, archives) by referencing files in its [workspace](#files) — the raw bytes never pass through the model. To upload, it sends a workspace file either as the raw request body or as part of a multipart request alongside text fields. To download, it saves the response straight to a workspace file instead of reading it as text. This uses the same credential injection as any other call — for example, uploading a generated report to Google Drive or Slack, or fetching a file to process. Uploads and downloads are capped at 25 MB per file.

Multipart uploads default to `multipart/form-data`. For APIs that require `multipart/related` — such as a Google Drive multipart upload, where a JSON metadata part precedes the media — the agent sets the multipart subtype to `related`; the platform assembles the ordered envelope and boundary so the metadata and file are sent as one request.

## Human interaction

### `ask_human`

Pauses the agent and asks you a question — in chat as a prompt card, on [channels](/guide/channels) as a message with buttons. The agent waits up to 35 minutes for your reply, then continues with the answer (or times out without one).

## Memory

These three tools exist only when the agent has an **embedding model** configured — see [Agent Memory](/guide/memory).

| Tool            | What it does                                                                      |
| --------------- | --------------------------------------------------------------------------------- |
| `memory_write`  | Stores an entry in the agent's vector memory. The server generates the embedding. |
| `memory_search` | Semantic search over the agent's memory.                                          |
| `memory_delete` | Deletes memory entries by ID (used for cleanup and deduplication).                |

## Files

Each agent has a private, persistent **workspace directory**. File tools are confined to it — path traversal outside the workspace is blocked.

| Tool         | What it does                                              |
| ------------ | --------------------------------------------------------- |
| `read_file`  | Reads a file from the workspace.                          |
| `write_file` | Writes a file (parent directories created automatically). |
| `list_files` | Lists a workspace directory.                              |

The workspace persists across conversations, so agents can keep notes, build up datasets, or maintain scripts between sessions.

## Code execution

| Tool           | What it does                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `run_terminal` | Runs a shell command in the workspace. 30-second timeout, 64 KB output cap, minimal environment. |
| `run_code`     | Runs a JavaScript or Python snippet (written to a temp file and executed under the same limits). |

In Docker-sandboxed deployments these run inside the per-turn container; whether they can reach the internet is controlled by the agent's [internet-access toggle](/guide/agents#allow-internet-access). In `process`-driver deployments they run on the host with code-level guards only — see [Security Overview](/guide/security).

## Web browsing

When the [web browser](/guide/browser) is enabled and the agent has internet access, the agent gains a set of `browser_*` tools to open pages, read them, fill in forms, click through flows, and take screenshots — for sites that have no API. The browser runs on the server, separate from the agent sandbox, and stays logged in between conversations. See the [Web Browser](/guide/browser) guide for the full list and how to manage it.

## Workflows

Agents can inspect and operate their own [workflows](/guide/workflows/):

| Tool               | What it does                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_workflows`   | Lists the agent's enabled workflows.                                                                                                                          |
| `read_workflow`    | Reads a workflow's full step-by-step definition.                                                                                                              |
| `trigger_workflow` | Starts a workflow run (fire-and-forget; returns the run ID and a link to the run page).                                                                       |
| `create_workflow`  | Creates a new workflow. The agent is required to present the full configuration to you via `ask_human` and get explicit confirmation **before** calling this. |

## Agent collaboration

These exist only when the agent has collaborators in its allow-list — see [Agent-to-Agent Messaging](/guide/agent-to-agent).

| Tool             | What it does                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `list_agents`    | Lists the agents this agent is allowed to message.                                                       |
| `ask_agent`      | Delegates to another agent and waits for its reply, which comes back as the tool result.                 |
| `send_to_agent`  | Hands a message to another agent without waiting (fire-and-forget; returns a link to the conversation).  |

## Per-turn limits

An agent may make at most **20 tool calls in a single turn**. On hitting the cap, the tool call is blocked and the agent must reply with text — so a runaway loop ends with an explanation rather than silence.
