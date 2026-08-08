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
- **Transient-error retry** — Sarvam's Azure gateway occasionally returns a `403` for chat
  completions, and network-level blips (timeouts, dropped sockets) also occur. The extension
  wraps the provider stream and retries with backoff
  (1 s / 3 s / 8 s) when the *first* event is a transient error (safe, because a `403` fails
  at connect time before any content streams). Non-Sarvam traffic passes through untouched.
- **256 KB request-size guard** — Sarvam's gateway rejects request bodies ≥ 256 KB with a
  `403`. Long sessions cross this and then fail every turn. The extension keeps the outgoing
  body under the limit by stubbing the content of the oldest messages (system prompt and the
  most recent turns are preserved; tool-call structure stays intact). This is
  **non-destructive** — only the outgoing request is trimmed; your session history is intact.
- **Editing guidance** — appends concrete file-editing rules to the system prompt to help
  the smaller models land exact-match edits.

All behaviour is scoped to the `sarvam` provider; other providers are unaffected. The
`read`/`write`/`edit` tool shims are registered globally (tools are per-session, not
per-provider) but pass arguments through untouched unless they carry Claude-style names, so
other providers see no change in behaviour.

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
pi install npm:pi-sarvam-provider@0.1.4   # pin a version
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
| `SARVAM_PROVIDER_RETRIES` | no | Provider-level retries for Sarvam traffic (default `2`). These are what honour a `Retry-After` header on 429. Set to `0` to disable. An explicit `retry.provider.maxRetries` in pi's settings (any value, including `0`) takes precedence over this variable. |

The base URL is `https://api.sarvam.ai/v1`.

## Notes & limitations

- The 256 KB guard is **crude compaction**: on oversized turns the model loses *old* tool
  outputs (it sees a stub) but keeps recent context and can re-read files. pi's own
  `/compact` can't help here because summarisation would itself exceed the 256 KB limit.
- The transient-error retry handles brief gateway blips (seconds) and network hiccups, not
  sustained multi-minute blocks. For a sustained outage, wait or switch models.

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
names as a local one; when two copies collide, the first-registered copy wins silently. Remove
the installed copy (`pi remove npm:pi-sarvam-provider`) before testing locally.

## Internals

The package exports one default function — pi's extension entry point. Everything below
lives inside it; nothing else is importable.

### Request paths

pi issues provider requests on two paths, and the shims have to cover both:

- **Normal turns** — pi supplies an `onPayload` callback, which is what fires the
  `before_provider_request` extension hook.
- **Compaction and branch summarisation** — these build their own request options and
  supply no callback, so no hook fires.

Payload normalisation (`developer` → `system`, array content → string, the 256 KB size
guard) is therefore attached as an `onPayload` on the options the provider wrapper passes
down — every Sarvam request funnels through that wrapper — rather than relying on the hook
alone. Before this, compaction reached Sarvam with array content and was rejected with
`body.messages.1.user.content : Input should be a valid string`.

### Retry layers

Two independent layers covering different failures:

| Layer | Handles | Timing |
| ----- | ------- | ------ |
| pi-ai `retryProviderRequest` | 408, 409, 429, 5xx | `Retry-After` when sent, else exponential backoff with jitter, capped by `retry.provider.maxRetryDelayMs` (60 s) |
| This extension's stream wrapper | Transient `403` gateway blips | Fixed ladder: 1 s / 3 s / 8 s |

pi ships `retry.provider.maxRetries` unset, which leaves the first layer inert, so the
extension requests retries for Sarvam traffic (`SARVAM_PROVIDER_RETRIES`) to get
`Retry-After` honoured — unless the user sets `retry.provider.maxRetries` themselves,
in which case their value (including an explicit `0` to disable) wins. pi-ai does not
retry `403`, so the second layer keeps that job. A `403` that looks like a bad key
rather than a blip is not retried at all.

### Tool argument shims

`read`, `write`, and `edit` are re-registered from pi's own factories with an added
`prepareArguments` step — the only hook that runs *before* schema validation:

- all three: `file_path` → `path`, plus Windows drive-prefix repair (`/E:/work` → `E:\work`)
- `edit` also maps `old_string`/`new_string` → `oldText`/`newText`, then delegates to pi's
  own edit-argument recovery

Array content → string is a message-payload transformation, not a tool one.

### Model discovery cache

Discovery runs once per process, so the cache is on disk
(`$XDG_CACHE_HOME/pi-sarvam-provider/models.json`, mode 600, 5-minute TTL): it saves the
`/v1/models` round-trip on the *next* launch. Entries are invalidated by base URL, a hash
of the API key, and TTL — the key itself is never written. Any cache I/O failure falls back
to fetching.

## License

[MIT](./LICENSE)
