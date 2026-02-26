# Changelog

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
