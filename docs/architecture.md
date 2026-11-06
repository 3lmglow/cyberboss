# Architecture

## Core

`core` is responsible for:

- reading config
- choosing which channel / runtime / integrations to use
- orchestrating capabilities instead of implementing concrete protocols

## Channel Adapters

`adapters/channel/*`

Responsible for:

- receiving messages
- sending messages
- typing / media / context token handling

Not responsible for:

- Codex / Claude Code thread logic
- reminder / timeline / diary logic

## Runtime Adapters

`adapters/runtime/*`

Responsible for:

- sending messages into the specific agent runtime
- handling thread / session / approval / stop

The `yukehome` adapter is a managed-main runtime. It does not start or attach to a second model process. It submits each owned turn to Yuke Home's loopback-authenticated bridge, which resolves the current main conversation and reuses Yuke Home's canonical persistence, identity, thread rebuild, and tools. The adapter maps only that HTTP response stream back to its originating WeChat target; it has no subscription path for turns started elsewhere.

Managed timers register their UUID, deadline and original text with the authenticated `/internal/cyberboss/reminders/resolve` endpoint. The local SQLite outbox (Node 22.13+) imports the old JSON queue once, keeps the addressed account local and polls until settlement. An active Yuke Home chat gets the reminder in its next genuine reply. Only a quiet, committed reply is eligible for WeChat; a chat receipt, silence, busy status or error is never sent as text. A lost backend response can be looked up by UUID. An uncertain external send stays marked locally and is not replayed. Update the Yuke Home backend (migration 119) before the bridge; restart the MCP writer with the bridge when upgrading from the old JSON writer.

Cyberboss's project tool host remains a separate stdio MCP server registered in the Yuke Home Codex configuration. In managed-main mode it exposes only the reminder, WeChat file-delivery, and sticker topics; unrelated diary, timeline, whereabouts, and internal-trigger tools stay out of Yuke Home's model context. Its runtime context file is reloaded on every tool call so the MCP process sees the current WeChat account, sender, and binding even though it is a different process.

Not responsible for:

- WeChat protocol details
- timeline UI

## Capability Integrations

`integrations/*`

Examples:

- `timeline`
- `reminder`
- `diary`

These capabilities should depend on external standalone projects whenever possible, instead of being folded back into the main repository.

## Expected External Dependencies

- timeline:
  - `timeline-for-agent`
- weixin bridge:
  - to be split into a standalone adapter
- codex runtime:
  - to be split into a standalone adapter
