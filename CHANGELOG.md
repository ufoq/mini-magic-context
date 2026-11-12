# Changelog

Mini Magic Context is a new project based on Magic Context. It keeps the source history, but its public package identity and version line start over at `0.1.0`.

It ships these packages together:

- `@ufoq/mini-magic-context` — setup / doctor CLI
- `@ufoq/opencode-mini-magic-context` — OpenCode plugin
- `@ufoq/pi-mini-magic-context` — Pi extension

## 0.1.1

Pi 1.4 compatibility: aligned session-entry projection and ID attribution with Pi's own reader, kept the persisted system entry out of the aligned-ID lane, and made consume-once projection handling fail closed. Release coverage adds the Pi host matrix and packed-artifact probes.

## 0.1.2

Late-adoption catch-up for sessions whose latest compaction was produced natively by Pi: startup now waits for one wrapup catch-up when MC coverage is behind, stages a real marker, and publishes summaries before the next request. Also preserves nested raw-provider ownership so an inner historian scope cannot unregister its caller's provider.

## 0.1.3

Reliability fixes for historian children and recomp publication:

- Keep Pi children alive through host retries, compaction and delayed settlement instead of terminating them on a fixed short drain.
- Reserve a termination budget across the whole invocation and never report an unconfirmed live child as success.
- Preserve terminal timeout, abort and cleanup failures across the recomp boundary; stop smaller-chunk retries after them.
- Walk the configured fallback chain once, not twice.
- Parse Pi JSONL on LF only, preserving U+2028/U+2029 and final unterminated records.
- Correct Pi-native retry classification for network errors, account limits and bounded HTTP statuses.
- Filter ambient MCP tools by default in historian children.

## 0.1.0

Initial Mini Magic Context line based on Magic Context `0.33.1`, with the retained surface narrowed to historian-managed context, journal search, compartment embeddings, `ctx_search`, `ctx_expand`, retained context commands, and `/mc-import-context`.
