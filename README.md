# pi-sarvam-provider

A [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding-agent
extension that registers **Sarvam AI** as a model provider and transparently applies
the compatibility shims its OpenAI-compatible endpoint needs.

Sarvam's `/v1/chat/completions` endpoint is OpenAI-shaped but has a few quirks that make
it fail out of the box with a general agent harness — a rejected `developer` role,
string-only message content, a 256 KB gateway request limit, and small models that emit
Claude-style tool arguments. This extension handles all of them so Sarvam models "just
work" in pi.

## Features

- **Provider registration** — discovers Sarvam models from `/v1/models` and registers
  them (reasoning enabled, thinking-level mapping, text input).
- **`developer` → `system` role** — Sarvam rejects the `developer` role pi sends for the
  system prompt of reasoning models. Fixed via `compat.supportsDeveloperRole: false`, with
  a payload-level safety net.
- **Array content → string** — Sarvam requires `message.content` to be a plain string; pi
  sends content as an array of parts. The extension flattens text parts to a string.
- **Tool-argument remapping** — smaller Sarvam models emit Claude-style tool arguments
  (`file_path`, `old_string`/`new_string`). These are remapped to pi's schema
  (`path`, `edits[{oldText,newText}]`) **before** schema validation via `prepareArguments`,
  composed with pi's own edit-argument recovery (so JSON-string `edits` still work).
- **Windows path sanitisation** — strips a spurious leading separator before a drive
  letter (`/E:/work` → `E:\work`) to avoid `path.resolve` doubling the drive
  (`E:\E:\work…`) and failing `mkdir`.
- **Transient 403 retry** — Sarvam's Azure gateway occasionally returns a `403` for chat
  completions. The extension wraps the provider stream and retries with backoff
  (1 s / 3 s / 8 s) when the *first* event is a transient error (safe, because a 403 fails
  at connect time before any content streams). Non-Sarvam traffic passes through untouched.
- **256 KB request-size guard** — Sarvam's gateway rejects request bodies ≥ 256 KB with a
  `403`. Long sessions cross this and then fail every turn. The extension keeps the outgoing
  body under the limit by stubbing the content of the oldest messages (system prompt and the
  most recent turns are preserved; tool-call structure stays intact). This is
  **non-destructive** — only the outgoing request is trimmed; your session history is intact.
- **Editing guidance** — appends concrete file-editing rules to the system prompt to help
  the smaller models land exact-match edits.

All behaviour is scoped to the `sarvam` provider; other providers are unaffected.

## Requirements

- pi (the `@earendil-works/pi-coding-agent` CLI), v0.80 or newer.
- A Sarvam API key in the `SARVAM_API_KEY` environment variable.
- Node 18+ (for global `fetch`).

## Install

```sh
pi install npm:pi-sarvam-provider
```

Then set your key and select a model:

```sh
export SARVAM_API_KEY="sk-..."        # PowerShell: $env:SARVAM_API_KEY = "sk-..."
pi
# /model -> pick a sarvam-* model
```

Add the `export` line to your shell config (`~/.zshrc`, `~/.bashrc`) to keep the key across
sessions.

Other useful commands:

```sh
pi list                              # show installed packages
pi install npm:pi-sarvam-provider@0.1.2   # pin a version
pi update npm:pi-sarvam-provider     # update to the latest release
pi remove npm:pi-sarvam-provider     # uninstall
pi install -l npm:pi-sarvam-provider # install into this project only (.pi/npm/)
```

Alternatively, list the package in the `packages` array of your pi `settings.json`
(`~/.pi/agent/settings.json`) and pi will install it on next start:

```jsonc
{
  "packages": [
    "npm:pi-sarvam-provider"
  ]
}
```

> If you previously had a local `sarvam.ts` in `~/.pi/agent/extensions/`, delete it after
> installing this package to avoid registering the provider twice.

## Configuration

| Variable          | Required | Description                          |
| ----------------- | -------- | ------------------------------------ |
| `SARVAM_API_KEY`  | yes      | Your Sarvam API key. The provider is not registered if this is unset. |
| `SARVAM_DEBUG`    | no       | Set to `true` for per-request debug logging and a metrics summary on exit. |
| `SARVAM_PROVIDER_RETRIES` | no | Provider-level retries for Sarvam traffic (default `2`). These are what honour a `Retry-After` header on 429. Set to `0` to disable. |

The base URL is `https://api.sarvam.ai/v1`.

## Notes & limitations

- The 256 KB guard is **crude compaction**: on oversized turns the model loses *old* tool
  outputs (it sees a stub) but keeps recent context and can re-read files. pi's own
  `/compact` can't help here because summarisation would itself exceed the 256 KB limit.
- The transient-403 retry handles brief gateway blips (seconds), not sustained multi-minute
  blocks. For a sustained outage, wait or switch models.

## Development

```bash
pnpm install
pnpm run typecheck
```

To try a local change without installing the package, load the source directly — `-ne`
disables other extensions so nothing else interferes:

```bash
pi -ne -e ./src/index.ts --provider sarvam --model sarvam-105b
```

Note that an installed copy of this package registers the same `read`/`write`/`edit` tool
names as a local one, and pi rejects the duplicate rather than choosing between them. Remove
the installed copy (`pi remove npm:pi-sarvam-provider`) before testing locally.

## License

[MIT](./LICENSE)
