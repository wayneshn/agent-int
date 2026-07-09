---
layout: home

hero:
  name: 'Valmis'
  text: 'The AI agent that talks to your apps'
  tagline: A self-hosted platform for building LLM-powered agents that chat with you, call your services, remember what matters, and run on a schedule — with every credential and API key staying on your own server.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Install with Docker
      link: /guide/installation
    - theme: alt
      text: What is Valmis?
      link: /guide/what-is-valmis

features:
  - title: Build agents in minutes
    details: Give an agent a name, a system instruction, a model, and a set of credentials. Chat with it in real time — streaming responses, visible tool calls, and live cost tracking included.
    link: /guide/agents
  - title: 100+ ready-made integrations
    details: Slack, GitHub, Gmail, Notion, Stripe, Home Assistant, and more. Each integration is a credential your agent can use to call the real API on your behalf.
    link: /integrations/
  - title: Connect any MCP server
    details: Register a Model Context Protocol server by URL or paste a standard mcpServers config, choose which tools to expose, and attach it to your agents — instant access to the wider MCP ecosystem.
    link: /guide/mcp-servers
  - title: Long-term memory
    details: Agents store episodic, semantic, procedural, and working memories in a vector database and recall them with semantic search across sessions.
    link: /guide/memory
  - title: Automated workflows
    details: Chain agent steps into multi-stage pipelines triggered manually, on a cron schedule, by signed webhooks, or by app events (new email, Notion change, form submission) — with run history and live step logs.
    link: /guide/workflows/
  - title: Telegram & Discord channels
    details: Pair an agent with your own Telegram or Discord bot and talk to it from your phone. Human-in-the-loop prompts arrive as tappable buttons.
    link: /guide/channels
  - title: Self-hosted and sandboxed
    details: Credentials are AES-256-GCM encrypted at rest, and agent code runs in an isolated sandbox that never sees your API keys, database, or secrets.
    link: /guide/security
---
