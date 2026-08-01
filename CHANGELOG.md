# Changelog

All notable changes to `pi-sarvam-provider` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-08-01

### Changed

- **Relicensed from Apache-2.0 to MIT.** The `license` field and `LICENSE` file both change;
  the copyright holder is unchanged. Note that 0.1.0 and 0.1.1 were published under
  Apache-2.0 and remain so — this applies from 0.1.2 onward.
- Added `repository`, `homepage`, and `bugs` metadata now that the GitHub repository exists,
  so the npm page links back to the source.
- Corrected the release-link account in this file (`rocknarayan` → `nrynss`); the earlier
  links pointed at a GitHub user that does not own this repository. The 0.1.0 and 0.1.1 link
  definitions were dropped rather than repointed: this repository's history begins at 0.1.2,
  so there are no tags for them to resolve to.
- Replaced the stale "Before you publish" section of the README with a Development section,
  including the local-testing conflict caveat (an installed copy and a locally loaded copy
  register the same tool names, and pi rejects the duplicate). A leftover copy of the old
  section survived under Install, still referencing `npm pack` and a `0.1.0` tarball; it is
  now removed.
- **Rewrote the README Install section around `pi install npm:pi-sarvam-provider`.** The
  section previously only documented hand-editing the `packages` array in
  `~/.pi/agent/settings.json`, which is now shown as the alternative. Added the related
  package commands (`pi list`, `pi update`, `pi remove`, version pinning, `-l` for
  project-local installs) and a note on persisting `SARVAM_API_KEY` in a shell config.

## [0.1.1] - 2026-07-30

### Fixed

- **Extension no longer fails `tsc`** — the api-registry helpers (`getApiProvider`,
  `registerBuiltInApiProviders`) are now imported from `@earendil-works/pi-ai/compat`
  instead of the package root. pi injects the compat barrel for the bare specifier at
  runtime, but the root's *types* are the newer narrow surface and declare none of them,
  so the old import ran correctly yet failed typecheck. The `/compat` subpath is the same
  module with matching types. Note this entrypoint is documented upstream as temporary;
  it will need a `createProvider` migration when pi-ai removes it.
- **Model discovery failures are handled** — a non-2xx response, a non-JSON body, an empty
  model list, or an unreachable host now log a warning and skip provider registration.
  Previously any of these threw out of the extension entry point (`models.data` is
  `undefined` on an error body, so `.map` raised a `TypeError`), surfacing as an opaque
  stack trace. Note Sarvam's `/v1/models` answers `200` even for an invalid key, so a bad
  key is not caught here — it first surfaces on the completion request.
- **Invalid API keys fail fast** — Sarvam returns `403` for both transient gateway blips
  and a permanently invalid key, so the retry filter treated an auth failure as retryable
  and burned the full backoff ladder before failing anyway (measured: 16s, now 3.6s). The
  body's error code now distinguishes the two.
- **Oversized tool-call arguments are trimmed** — the last-resort stage of the 256 KB guard
  capped message content only. A recent `write` call carrying a whole file body lives in
  `tool_calls[].function.arguments`, which the earlier stage stubs only for *older*
  messages, so such a request stayed oversized and still hit the 403. Oversized arguments
  are now blanked to `{}` rather than sliced, since a truncated JSON string is invalid.
- **No more orphaned `tool` messages** — when dropping the oldest turns found no user-message
  boundary, the fallback sliced by message count and could start the conversation on a
  `tool` message whose `tool_call` had been dropped, which the endpoint rejects. It now
  falls back to the last user turn (shrunk by the hard cap) or keeps nothing.
- **Aborting during retry backoff is immediate** — the backoff `sleep` now races the timer
  against the abort signal instead of always running to completion (up to 8s late).
- **`streamSimple` delegates to the base `streamSimple`**, not `stream`, matching the options
  shape pi passes to the function it is registered as.

### Changed

- Bumped the `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` devDependencies
  from `^0.80.2` to `^0.83.0`, matching the version pi actually loads at runtime. While they
  disagreed, `tsc` and pi were checking different copies of the package — the root cause of
  the compat-entrypoint mismatch above.
- Added `pnpm-workspace.yaml` declaring two transitive dev-only install scripts as not
  built, so `pnpm install` exits 0 and `pnpm run typecheck` is not blocked by pnpm's
  dep-status check.

## [0.1.0] - 2026-06-28

First release. Registers Sarvam AI as a pi model provider and adds the compatibility
shims its OpenAI-compatible endpoint needs. All behaviour is scoped to the `sarvam`
provider; other providers are untouched.

### Added

- **Provider registration** — discovers models from `https://api.sarvam.ai/v1/models`
  and registers them with reasoning enabled, thinking-level mapping, and text input.
  Requires the `SARVAM_API_KEY` environment variable.
- **`developer` → `system` role** — sets `compat.supportsDeveloperRole: false` so pi
  stops sending the `developer` role (which Sarvam rejects) for reasoning models, plus a
  payload-level remap as a safety net.
- **Array content → string** — flattens pi's array-of-parts message content to the plain
  string Sarvam requires.
- **Tool-argument compatibility** — remaps Claude-style tool arguments
  (`file_path` → `path`, `old_string`/`new_string` → `edits[{oldText,newText}]`) via
  `prepareArguments`, *before* schema validation, composed with pi's own edit-argument
  recovery (so JSON-string `edits` keep working).
- **Windows path sanitisation** — strips a spurious leading separator before a drive
  letter (`/E:/work` → `E:\work`) to prevent `path.resolve` from doubling the drive
  (`E:\E:\work…`) and failing `mkdir`.
- **Transient-error retry** — wraps the provider stream and retries with backoff
  (1 s / 3 s / 8 s) when the first stream event is a transient error (403 / 429 / 5xx /
  gateway), which is safe because such failures occur at connect time before any content
  streams. Non-Sarvam traffic passes through untouched.
- **256 KB request-size guard** — Sarvam's gateway rejects request bodies ≥ 256 KB with a
  `403` (verified: 255 KB → 200, 262 KB → 403). The guard keeps the outgoing body under the
  limit, escalating only as needed:
  1. stub the content (and tool-call arguments) of older messages, preserving the system
     prompt and the most recent turns;
  2. when the message *count* alone is too large (per-message JSON + tool-call ids), drop
     the oldest turns — cutting at a user-message boundary so no tool message is orphaned
     and no tool_call is left dangling;
  3. as a last resort, hard-cap any remaining oversized content.

  This is non-destructive: only the outgoing request is trimmed; the session history on
  disk is left intact.
- **Editing guidance** — appends concrete exact-match editing rules to the system prompt to
  help smaller Sarvam models land edits reliably.

[0.1.2]: https://github.com/nrynss/pi-sarvam-provider/releases/tag/v0.1.2
