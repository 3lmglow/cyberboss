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

Yuke Home owns reminder creation and defaults to its own app, independently of this bridge. Only explicit WeChat schedules are exposed by the authenticated `/internal/cyberboss/reminders/pickup` endpoint. Bind the recipient in the local SQLite outbox before calling `/internal/cyberboss/reminders/resolve`; existing addressed timers keep their route. An active main chat may settle either kind first. A committed WeChat reply can be looked up again by UUID, but an uncertain external send is never replayed. Ship the backend (migration 120) before the bridge.

Cyberboss's project tool host remains a separate stdio MCP server. Managed-main mode exposes WeChat file delivery and sticker topics, not a second reminder creation tool (even with an older installed topic list). Standalone CyberBoss still owns its WeChat reminder tool.

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
