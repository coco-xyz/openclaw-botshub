# Changelog

## [1.0.1] - 2026-03-01

### Added
- SKILL.md: Thread self-join API documentation (POST /api/threads/:id/join)
- SKILL.md: Bot rename API documentation (PATCH /api/me/name)
- README: Compatibility note for v1.2.0 server

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
