# Data flow & variables

Workflows pass data forward. Every node's result is available to the nodes after it, and the trigger's payload is available throughout. You reference that data with <code v-pre>{{ … }}</code> template variables in instructions, conditions, loop items, input mappings, and rule fields.

## Variables

| Variable | Resolves to |
| -------- | ----------- |
| <code v-pre>{{trigger.payload}}</code> | The data the trigger delivered — a webhook body, an app event, or a payload passed to <code v-pre>trigger_workflow</code>. Drill in with dot paths, e.g. <code v-pre>{{trigger.payload.subject}}</code>. |
| <code v-pre>{{steps.&lt;nodeId&gt;.output}}</code> | An earlier node's full result. |
| <code v-pre>{{steps.&lt;nodeId&gt;.output.field.sub}}</code> | A field within an earlier result, via a dot path. |
| <code v-pre>{{steps.&lt;index&gt;.output}}</code> | The same, by zero-based position — a legacy alias for simple linear workflows. |
| <code v-pre>{{loop.item}}</code> / <code v-pre>{{loop.index}}</code> | Inside a loop body — the current element and its index. |

### Where node ids come from

Each editable node shows an **Output ref** box at the top of its config drawer, with a **Copy** button — it copies that node's <code v-pre>{{steps.&lt;nodeId&gt;.output}}</code>. Copy it from the node you want to read, paste it into the node that needs the data, and add a dot path for a specific field.

A node's result shape depends on its type:

| Node | Result |
| ---- | ------ |
| Agent step (free text) | `{ "text": "…" }` |
| Agent step (with [output schema](/guide/workflows/steps#output-schema)) | the JSON object you defined |
| [Condition](/guide/workflows/conditions) | `{ "result": true, "reason": "…" }` |
| [Loop](/guide/workflows/loops) | `{ "iterations": 3, "results": [ … ] }` |

## Automatic context

You usually don't need to wire anything. By default, **every step, condition, and loop receives the results of all previously-executed nodes plus the trigger payload** — labeled by step index, name, type, and id — so the agent already has the full picture so far.

This includes each node's **result only**, never the tool calls it made internally. A condition or loop in **smart** mode uses this same context to make its decision.

**Inside a loop body**, a step with no input mapping instead receives the **current item** (the same value as <code v-pre>{{loop.item}}</code>) plus its index — so each iteration processes one element. Reference earlier steps or the trigger from a loop body with an explicit input mapping.

## Input mapping (override)

To control exactly what a step receives, set its **Input mapping** — a template that **replaces** the automatic context with only what you map:

```
Summarize this email:
Subject: {{trigger.payload.subject}}
Body: {{trigger.payload.body}}
```

Use it to keep a step focused, hide noise from unrelated branches, or reshape data. When the field is empty, the automatic context is used instead.

::: tip Keep results compact
Because every step's result is fed to later steps, large free-text outputs add up. Give steps an [output schema](/guide/workflows/steps#output-schema) so they return small, structured objects — cheaper context and easier to reference by field.
:::

Unresolved references — a wrong id or a missing field — are left in the text as-is rather than erroring, so a typo shows up plainly in the step's logged input.
