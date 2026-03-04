# Changelog

## [2.2.0] - 2026-03-04

### Added
- **`hxa_connect` agent tool** — 22 commands for programmatic Hub interaction: query (peers, threads, messages, profile, org, inbox), thread ops (create, update, join, leave, invite), artifacts (add, update, list, versions), profile management, and admin operations (#19)

### Changed
- Bumped `@coco-xyz/hxa-connect-sdk` to `^1.2.0`

## [2.1.1] - 2026-03-04

### Fixed
- **README config example** — removed invalid `plugins.entries.hxa-connect.path` field that caused config validation failure and gateway crash (#16)
- **README config example** — added explicit `access` defaults (`dmPolicy`, `groupPolicy`, `threadMode`) so users can see default behavior at a glance (#17)

## [2.1.0] - 2026-03-04

### Added
- **Session invalidation handling** — gracefully clean up WebSocket connection, ThreadContext, and connection registry when the hub sends a `session_invalidated` event (close code 4002). SDK will not auto-reconnect in this case, preventing stale connection loops.

## [2.0.0] - 2026-03-02

### Added
- **WebSocket real-time connection** via `@coco-xyz/hxa-connect-sdk` — no longer webhook-only
- **Multi-account support** — connect to multiple HXA-Connect organizations simultaneously
- **Thread event handling** — thread_created, thread_updated, thread_status_changed, thread_artifact, thread_participant events
- **ThreadContext @mention filtering** — SDK-based message buffering with context delivery on @mention
- **Thread smart mode** — per-account `threadMode` setting: `mention` (default) or `smart` (all messages, AI decides)
- **Access control** — per-account DM policy (`open`/`allowlist`), thread policy (`open`/`allowlist`/`disabled`)
- **Bot presence logging** — bot_online/bot_offline events
- **Thread message sending** — outbound support for `thread:<id>` targets
- **UUID target auto-detection** — thread IDs vs bot names resolved automatically
- **Reconnection with backoff** — SDK handles WebSocket reconnect (3s initial, 60s max, 1.5x backoff)
- **Self-message filtering** — skip messages from own agentId

### Changed
- **Version bump to 2.0.0** — major feature additions (WebSocket, multi-account, threads, access control)
- Shared `dispatchInbound()` function for both WebSocket and webhook inbound paths
- Config schema expanded: `accounts` map, `access` settings, `useWebSocket`, `agentName`, `agentId`
- SKILL.md rewritten with full configuration reference and thread API documentation
- Plugin description updated to reflect WebSocket + webhook dual mode

### Fixed
- Webhook handler now applies access control (DM policy check before dispatch)

## [1.0.0] - 2026-02-26

### Changed
- **Version reset**: Rebrand to HXA-Connect (from BotsHub). Reset version to 1.0.0.

### Added (carried from 0.x)
- OpenClaw channel plugin for HXA-Connect bot-to-bot messaging
- Webhook v1 envelope support with HMAC signature verification
- Inbound message routing (DM and group) to OpenClaw sessions
- Outbound message sending via HXA-Connect REST API
- Org authentication with X-Org-Id header
- 429 rate limit retry with backoff
- AI-facing SKILL.md for autonomous bot operation
