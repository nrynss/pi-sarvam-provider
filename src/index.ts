/**
 * pi-sarvam-provider
 *
 * Registers Sarvam AI as a model provider for the pi coding agent and applies the
 * compatibility shims its OpenAI-compatible endpoint needs:
 *
 *  - developer -> system role (Sarvam rejects the `developer` role)
 *  - array message content -> plain string (Sarvam requires string content)
 *  - tool-argument remapping for Claude-style names (file_path -> path, etc.),
 *    composed with pi's own edit-argument recovery
 *  - Windows path sanitisation (/E:/x -> E:\x) to avoid drive-doubling
 *  - automatic retry with backoff on transient 403 / gateway blips
 *  - request-body trimming to stay under Sarvam's 256 KB gateway limit
 *  - editing guidance tuned for smaller models
 *
 * Requires the SARVAM_API_KEY environment variable.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
} from "@earendil-works/pi-coding-agent";
// NOTE: import from "/compat", not the package root. pi injects the compat barrel
// for the bare specifier at runtime, but the root's *types* (dist/index.d.ts) are the
// new narrow surface and declare none of the api-registry helpers below — so the bare
// specifier runs fine and fails `tsc`. The "/compat" subpath is the same module with
// matching types, and pi's extension loader resolves it (verified). This entrypoint is
// documented as temporary; when pi-ai drops it, move to `createProvider`.
import {
  getApiProvider,
  registerBuiltInApiProviders,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/compat";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ModelResponse {
  data: Array<{
    id: string;
    context_window?: number;
    max_tokens?: number;
  }>;
}

// Model discovery cache.
//
// Discovery runs exactly once per process, during activate — so an in-memory cache
// can never serve a hit (the process always starts cold, misses, writes, and exits
// without reading again). The only way this saves anything is on disk, where it
// skips the /v1/models round-trip on the *next* pi launch.
//
// Keyed by base URL plus a hash of the API key, so rotating the key invalidates the
// cache rather than serving models the new key may not have access to. The key
// itself is never written to disk.
interface ModelCacheEntry {
  baseUrl: string;
  keyHash: string;
  models: ModelResponse;
  timestamp: number;
  ttl: number;
}

const CACHE_DIR = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "pi-sarvam-provider"
);
const CACHE_FILE = join(CACHE_DIR, "models.json");
const DEFAULT_TTL = 300000; // 5 minutes

const keyHashOf = (apiKey: string) =>
  createHash("sha256").update(apiKey).digest("hex").slice(0, 12);

// Every failure path here is non-fatal: a missing, corrupt, stale, or unreadable
// cache just means we fetch fresh. Model discovery must never break on cache I/O.
const readCachedModels = (apiKey: string, baseUrl: string): ModelResponse | null => {
  try {
    const entry = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as ModelCacheEntry;
    if (entry.baseUrl !== baseUrl) return null;
    if (entry.keyHash !== keyHashOf(apiKey)) return null;
    // Type-check the clock fields: a hand-edited or truncated entry with a string
    // timestamp/ttl makes the comparisons NaN (never stale), so the entry would
    // serve forever even after the key is rotated.
    if (typeof entry.timestamp !== "number" || !Number.isFinite(entry.timestamp)) return null;
    if (typeof entry.ttl !== "number" || !Number.isFinite(entry.ttl)) return null;
    if (Date.now() - entry.timestamp >= entry.ttl) return null;
    if (!Array.isArray(entry.models?.data)) return null;
    // A corrupt entry can pass the array check with garbage members; only accept
    // entries whose model ids are usable strings.
    if (!entry.models.data.every(m => typeof m?.id === "string" && m.id.length > 0)) return null;
    return entry.models;
  } catch {
    return null;
  }
};

const writeCachedModels = (apiKey: string, baseUrl: string, models: ModelResponse): void => {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const entry: ModelCacheEntry = {
      baseUrl,
      keyHash: keyHashOf(apiKey),
      models,
      timestamp: Date.now(),
      ttl: DEFAULT_TTL,
    };
    writeFileSync(CACHE_FILE, JSON.stringify(entry), { mode: 0o600 });
  } catch (err) {
    debugLog(`Could not write model cache: ${err instanceof Error ? err.message : String(err)}`);
  }
};

// Model discovery monitoring
interface ModelDiscoveryMetrics {
  cacheHits: number;
  cacheMisses: number;
  apiCalls: number;
  errors: number;
}

const modelMetrics: ModelDiscoveryMetrics = {
  cacheHits: 0,
  cacheMisses: 0,
  apiCalls: 0,
  errors: 0
};

// General provider monitoring metrics
interface ProviderMetrics {
  totalRequests: number;
  totalDuration: number;
  avgDuration: number;
  retryAttempts: number;
  streamErrors: number;
  toolCalls: number;
  contentTransformations: number;
  sizeGuardTriggers: number;
  toolCallTypes: Record<string, number>;
}

const providerMetrics: ProviderMetrics = {
  totalRequests: 0,
  totalDuration: 0,
  avgDuration: 0,
  retryAttempts: 0,
  streamErrors: 0,
  toolCalls: 0,
  contentTransformations: 0,
  sizeGuardTriggers: 0,
  toolCallTypes: {} as Record<string, number>
};

// Optional debug logging
const debugLog = (message: string) => {
  if (process.env.SARVAM_DEBUG === "true") {
    console.log(`[Sarvam Provider] ${message}`);
  }
};

// Debug metrics summary. Registered on process exit rather than called during
// activate — at activate time every counter is still zero, so the summary only
// carries information once the session has actually run.
const debugMetrics = () => {
  if (process.env.SARVAM_DEBUG !== "true") return;
  if (providerMetrics.totalRequests === 0 && modelMetrics.apiCalls === 0) return;

  const totalTime = providerMetrics.totalDuration;
  const toolCallBreakdown = Object.entries(providerMetrics.toolCallTypes)
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");

  console.log(`
=== Sarvam Provider Metrics ===
Total Requests: ${providerMetrics.totalRequests}
Total Duration: ${totalTime}ms
Avg Duration: ${totalTime > 0 ? (totalTime / providerMetrics.totalRequests).toFixed(2) : 0}ms
Retry Attempts: ${providerMetrics.retryAttempts}
Stream Errors: ${providerMetrics.streamErrors}
Tool Calls: ${providerMetrics.toolCalls} (${toolCallBreakdown})
Content Transformations: ${providerMetrics.contentTransformations}
Size Guard Triggers: ${providerMetrics.sizeGuardTriggers}
Cache Hits: ${modelMetrics.cacheHits}
Cache Misses: ${modelMetrics.cacheMisses}
API Calls: ${modelMetrics.apiCalls}
Errors: ${modelMetrics.errors}
==================================
`);
};

export default async function (pi: ExtensionAPI) {

  const apiKey = process.env.SARVAM_API_KEY;

  if (!apiKey) {
    console.warn("SARVAM_API_KEY not set.");
    return;
  }

  // ---------------------------------------------------------------------------
  // Tool argument compatibility shims.
  //
  // sarvam models emit Claude-style tool arguments (file_path, old_string,
  // new_string) instead of pi's schema (path, edits[{oldText,newText}]). In
  // pi's tool loop the order is: prepareArguments -> schema validation ->
  // tool_call event. So the ONLY hook that can fix argument names before
  // validation rejects them is `prepareArguments`. The `tool_call` event runs
  // after validation and is too late.
  //
  // Re-registering read/write/edit overrides the built-ins by name (extension
  // tools win on name collision) while reusing pi's own factories, so behavior
  // and prompt metadata are identical apart from the added shim.
  // ---------------------------------------------------------------------------
  const cwd = process.cwd();

  // sarvam models sometimes emit a Windows path with a spurious leading separator
  // before the drive, e.g. "/E:/work/vimanam" or "\E:\work". pi's resolvePath sees
  // that as absolute and path.resolve() re-roots it onto the *current* drive,
  // producing a doubled "E:\E:\work\vimanam" that then fails mkdir/ENOENT. Strip the
  // leading separator so the drive-qualified path resolves cleanly.
  const fixWinPath = (p: unknown): unknown => {
    if (typeof p !== "string" || process.platform !== "win32") return p;
    const m = /^[/\\]([A-Za-z]):(.*)$/.exec(p);
    return m ? `${m[1]}:${m[2]}` : p;
  };

  const remapPath = (a: Record<string, unknown>) => {
    if (a.file_path != null && a.path == null) a.path = a.file_path;
    delete a.file_path;
    if (typeof a.path === "string") a.path = fixWinPath(a.path);
  };

  const readDef = createReadToolDefinition(cwd);
  readDef.prepareArguments = (args: unknown) => {
    const a = { ...(args as Record<string, unknown>) };
    remapPath(a);

    // Track read tool calls
    providerMetrics.toolCalls++;
    providerMetrics.toolCallTypes.read = (providerMetrics.toolCallTypes.read || 0) + 1;

    return a as never;
  };
  pi.registerTool(readDef);

  const writeDef = createWriteToolDefinition(cwd);
  writeDef.prepareArguments = (args: unknown) => {
    const a = { ...(args as Record<string, unknown>) };
    remapPath(a);

    // Track write tool calls
    providerMetrics.toolCalls++;
    providerMetrics.toolCallTypes.write = (providerMetrics.toolCallTypes.write || 0) + 1;

    return a as never;
  };
  pi.registerTool(writeDef);

  const editDef = createEditToolDefinition(cwd);
  // pi's edit tool ships its own prepareArguments (prepareEditArguments) that also
  // recovers from `edits` sent as a JSON string and folds legacy oldText/newText
  // into edits[] — both common with smaller models. Chain it instead of replacing
  // it: map the Claude-style names to pi's legacy names, then delegate.
  const piEditPrepare = editDef.prepareArguments;
  editDef.prepareArguments = (args: unknown) => {
    const a = { ...(args as Record<string, unknown>) };
    remapPath(a);
    // Only fold Claude-style old_string/new_string into oldText/newText when BOTH
    // are present and non-empty. A one-sided call is a model error, and guessing is
    // destructive: with only new_string the shim would fabricate oldText "" (the
    // edit engine rejects it — a wasted turn), and with only old_string it would
    // fabricate newText "" and silently DELETE the matched text from the file.
    // Leaving the args untouched makes schema validation reject the call cleanly
    // so the model retries with both fields.
    if (typeof a.old_string === "string" && a.old_string.length > 0 &&
        typeof a.new_string === "string" && a.new_string.length > 0) {
      if (a.oldText == null) a.oldText = a.old_string;
      if (a.newText == null) a.newText = a.new_string;
    }
    delete a.old_string;
    delete a.new_string;
    delete a.replace_all;

    // Track edit tool calls
    providerMetrics.toolCalls++;
    providerMetrics.toolCallTypes.edit = (providerMetrics.toolCallTypes.edit || 0) + 1;

    return (piEditPrepare ? piEditPrepare(a) : a) as never;
  };
  pi.registerTool(editDef);

  // ---------------------------------------------------------------------------
  // Transient-error retry (403 / gateway blips).
  //
  // Sarvam's Azure gateway intermittently returns 403 (and other transient
  // statuses) for chat completions. pi treats 403 as non-retryable, so the turn
  // dies with empty content and resuming just re-hits it. A 403 fails at connect
  // time: the underlying stream pushes its `error` event BEFORE any `start`/
  // content event (openai-completions pushes `start` only after the request
  // succeeds). So if the FIRST event is a transient error, nothing has streamed
  // and re-issuing the request is safe.
  //
  // The streamSimple we register is a field of the sarvam provider, so this wraps
  // only sarvam traffic — other providers keep pi's own stream untouched.
  //
  // Ensure the built-in API providers exist before we look one up (idempotent; does
  // not clobber existing registrations), so this works regardless of pi's init order.
  // Capture the *function*, not the registry entry, so a later registry mutation can
  // never turn our own wrapper into the thing we call and recurse.
  // ---------------------------------------------------------------------------
  registerBuiltInApiProviders();
  // We are registered AS streamSimple, so delegate to the base streamSimple — its
  // options shape is what pi hands us. (`.stream` takes the richer options type.)
  const baseStreamSimple = getApiProvider("openai-completions")?.streamSimple as
    | ((m: unknown, c: unknown, o: unknown) => AsyncIterable<Record<string, unknown>>)
    | undefined;

  const TRANSIENT = /\b(403|408|425|429|500|502|503|504)\b|forbidden|too many requests|rate.?limit|overloaded|temporar|unavailable|gateway|fetch failed|network error|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|UND_ERR_|socket closed|timed out|request timeout|connection.*closed|connection refused|\btls\b/i;

  // Sarvam returns 403 for BOTH transient gateway blips and a permanently bad key, so
  // the status alone can't separate them — the body's error code can. Note that
  // /v1/models answers 200 for an invalid key, so a bad key is not caught at
  // registration; it first surfaces here, on the completion request. Without this,
  // an invalid key burns the whole backoff ladder (~12s) before failing anyway.
  const PERMANENT = /invalid_api_key_error|invalid or missing authentication|unauthenticated|unauthorized|\b401\b/i;
  const shouldRetry = (message: string) => TRANSIENT.test(message) && !PERMANENT.test(message);

  // Retry-After, via pi's implementation rather than a second one.
  //
  // pi-ai's `retryProviderRequest` already honours `retry-after-ms` and
  // `retry-after` (delta-seconds and HTTP-date), caps a server-requested wait at
  // `maxRetryDelayMs` (60s default), and otherwise backs off exponentially with
  // jitter. It is inert unless `maxRetries > 0`, and pi ships
  // `retry.provider.maxRetries: 0` — so out of the box nothing honours Retry-After,
  // and a 429 falls straight through to the fixed ladder below, which burns all
  // three attempts in ~12s against a wait the gateway already told us about.
  //
  // We cannot read the header ourselves: the OpenAI SDK throws on non-2xx, so
  // `options.onResponse` — pi's only hook that carries response headers — never
  // fires on the failing request, and by the time the failure reaches this wrapper
  // it is just an error string.
  //
  // Enabling it in the options we pass down scopes it to sarvam. pi's own advice to
  // leave provider retries at 0 targets subscription providers, where SDK-level
  // retries can absorb out-of-quota errors and stall the agent until the quota
  // resets; Sarvam is metered per request and returns 429 for rate, not exhaustion.
  // This covers 408/409/429/5xx only — pi-ai does not retry 403, so Sarvam's
  // transient gateway 403s remain the ladder's job below.
  //
  // Set SARVAM_PROVIDER_RETRIES=0 to opt out; an explicit `retry.provider.maxRetries`
  // in pi's settings (any value, including 0) takes precedence over the env var.
  const PROVIDER_RETRIES = (() => {
    const raw = process.env.SARVAM_PROVIDER_RETRIES;
    if (raw === undefined) return 2;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : 2;
  })();

  const RETRY_DELAYS_MS = [1000, 3000, 8000]; // 3 retries after the initial attempt
  // Abort-aware: a cancelled turn should not have to wait out the full backoff.
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    });

  const errorEvent = (model: { api?: unknown; provider?: unknown; id?: unknown }, message: string, aborted = false) => ({
    type: "error",
    // pi's event protocol distinguishes aborts from failures: an aborted turn
    // must carry reason/stopReason "aborted" so session metadata records the
    // cancellation rather than an upstream error.
    reason: aborted ? "aborted" : "error",
    error: {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: aborted ? "aborted" : "error", errorMessage: message, timestamp: Date.now(),
    },
  });

  // pi supplies an `onPayload` callback — the thing that fires
  // `before_provider_request` — only on the normal turn path. Compaction and branch
  // summarization build their own request options (`createSummarizationOptions` in
  // pi's compaction.ts returns just `{maxTokens, signal, apiKey, headers, env}`), so
  // no hook fires, the payload reaches Sarvam with array-shaped content, and the
  // request dies with `body.messages.1.user.content : Input should be a valid
  // string` — index 1 being the summarization prompt. That failure surfaces as
  // "Auto-compaction failed" and, once the context is full, every turn then fails.
  //
  // Every sarvam request funnels through this wrapper, so attaching the normalizer
  // to the options we pass down covers both paths with one code path. Any callback
  // pi did supply still runs first, so the hook keeps its rewrite rights.
  const withPayloadNormalizer = (options: any) => {
    const prior = options?.onPayload;
    return {
      ...options,
      // pi's own default here is *undefined*, not 0 — the `??` (not `||`) matters:
      // an explicit `retry.provider.maxRetries: 0` in pi's settings must stay 0 to
      // actually disable the Retry-After layer. See PROVIDER_RETRIES above.
      maxRetries: options?.maxRetries !== undefined ? options.maxRetries : PROVIDER_RETRIES,
      onPayload: async (payload: unknown, model: unknown) => {
        const rewritten = prior ? await prior(payload, model) : undefined;
        const current = (rewritten ?? payload) as Record<string, unknown>;
        return normalizeSarvamPayload(current) ?? current;
      },
    };
  };

  const streamWithRetry = (model: any, context: any, options: any): any => {
    const startTime = Date.now();
    const out = createAssistantMessageEventStream();

    void (async () => {
      for (let attempt = 0; ; attempt++) {
        const attemptStart = Date.now();

        if (options?.signal?.aborted) {
          const duration = Date.now() - startTime;
          providerMetrics.totalRequests++;
          providerMetrics.totalDuration += duration;
          providerMetrics.avgDuration = providerMetrics.totalDuration / providerMetrics.totalRequests;

          debugLog(`Request aborted after ${duration}ms (attempt ${attempt + 1})`);
          (out as any).push(errorEvent(model, "Request was aborted", true));
          return;
        }

        let pushedAny = false;
        let retrying = false;
        let errorCount = 0;

        try {
          const src = baseStreamSimple!(model, context, withPayloadNormalizer(options));
          for await (const ev of src as AsyncIterable<any>) {
            if (
              ev?.type === "error" && !pushedAny && attempt < RETRY_DELAYS_MS.length &&
              !options?.signal?.aborted && shouldRetry(String(ev?.error?.errorMessage ?? ""))
            ) {
              retrying = true;
              errorCount++;
              break;
            }
            pushedAny = true;
            (out as any).push(ev);
            if (ev?.type === "done" || ev?.type === "error") {
              const duration = Date.now() - startTime;
              // A terminal error event is a failed request — count it, unless it is
              // an abort (the signal case), which is a cancellation, not an error.
              if (ev?.type === "error" && ev?.reason !== "aborted") providerMetrics.streamErrors++;
              providerMetrics.totalRequests++;
              providerMetrics.totalDuration += duration;
              providerMetrics.avgDuration = providerMetrics.totalDuration / providerMetrics.totalRequests;

              debugLog(`Stream completed in ${duration}ms (attempt ${attempt + 1}, ${errorCount} errors)`);
              return; // stream complete
            }
          }
          if (retrying) {
            const delay = RETRY_DELAYS_MS[attempt];
            providerMetrics.retryAttempts++;
            debugLog(`Retrying in ${delay}ms (attempt ${attempt + 1}, ${errorCount} errors)`);
            await sleep(delay, options?.signal);
            continue;
          }
          // Source ended without a terminal event: close defensively.
          const duration = Date.now() - startTime;
          providerMetrics.totalRequests++;
          providerMetrics.totalDuration += duration;
          providerMetrics.avgDuration = providerMetrics.totalDuration / providerMetrics.totalRequests;

          debugLog(`Stream ended without final event after ${duration}ms`);
          (out as any).push(errorEvent(model, "Stream ended without a final event."));
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const duration = Date.now() - startTime;
          errorCount++;

          if (!pushedAny && attempt < RETRY_DELAYS_MS.length && !options?.signal?.aborted && shouldRetry(msg)) {
            providerMetrics.retryAttempts++;
            debugLog(`Retrying after error: ${msg} (attempt ${attempt + 1}, ${errorCount} total errors)`);
            await sleep(RETRY_DELAYS_MS[attempt]!, options?.signal);
            continue;
          }

          providerMetrics.streamErrors++;
          providerMetrics.totalRequests++;
          providerMetrics.totalDuration += duration;
          providerMetrics.avgDuration = providerMetrics.totalDuration / providerMetrics.totalRequests;

          debugLog(`Stream error after ${duration}ms: ${msg} (attempt ${attempt + 1}, ${errorCount} total errors)`);
          (out as any).push(errorEvent(model, msg));
          return;
        }
      }
    })();

    return out;
  };

  // ---------------------------------------------------------------------------
  // Provider registration.
  // ---------------------------------------------------------------------------
  // Model discovery is a hard dependency: without it there is nothing to register.
  // Fail loudly but gracefully — an unreachable gateway or a rejected key must not
  // throw out of the extension entry point, which surfaces as an opaque stack trace.
  const BASE_URL = "https://api.sarvam.ai/v1";

  // Try to get cached models first
  let models: ModelResponse | null = readCachedModels(apiKey, BASE_URL);

  if (models) {
    modelMetrics.cacheHits++;
    debugLog(`Model cache hit (${models.data.length} models, skipping /v1/models)`);
  } else {
    modelMetrics.cacheMisses++;
    debugLog(`Model cache miss, fetching models from API`);
  }

  if (!models) {
    try {
      const response = await fetch(
        `${BASE_URL}/models`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`
          }
        }
      );

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300).trim();
        console.warn(
          `Sarvam: could not list models — HTTP ${response.status} ${response.statusText}.` +
          `${response.status === 401 || response.status === 403 ? " Check SARVAM_API_KEY." : ""}` +
          `${detail ? ` ${detail}` : ""}`
        );
        return;
      }

      models = (await response.json()) as ModelResponse;

      modelMetrics.apiCalls++;
      debugLog(`Successfully fetched ${models.data.length} models from API`);

      // Cache the successful response for the next pi launch
      writeCachedModels(apiKey, BASE_URL, models);

    } catch (err) {
      modelMetrics.errors++;
      console.warn(
        `Sarvam: could not reach ${BASE_URL}/models — ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
  }

  if (!Array.isArray(models?.data) || models.data.length === 0) {
    console.warn("Sarvam: /v1/models returned no models; provider not registered.");
    return;
  }

  pi.registerProvider("sarvam", {

    name: "Sarvam",

    baseUrl: BASE_URL,

    api: "openai-completions",

    apiKey: "$SARVAM_API_KEY",

    authHeader: true,

    // Wrap the base openai-completions stream with transient-error retry.
    // `undefined` when the base couldn't be resolved, which pi treats as
    // "no streamSimple" — the normal, unwrapped path.
    streamSimple: baseStreamSimple ? streamWithRetry : undefined,

    models: models.data.map(model => ({

      id: model.id,

      name: model.id,

      reasoning: true,

      input: ["text"],

      // Cap the context window so pi's own compaction triggers BEFORE Sarvam's
      // 256 KB gateway limit. That byte wall hits around ~35K tokens — far below
      // the model's real token window — so with a 128K window pi never compacts
      // and the request just grows until it 403s. With the cap, pi summarises old
      // turns properly (shouldCompact fires at contextWindow - reserveTokens); the
      // size guard below stays only as a last-resort backstop.
      contextWindow:
        Math.min(model.context_window ?? 128000, 46000),

      maxTokens:
        model.max_tokens ??
        16384,

      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      },

      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "high"
      },

      // Sarvam's OpenAI-compatible endpoint rejects the `developer` role that pi
      // sends for the system prompt of reasoning models. Force plain `system`.
      compat: {
        supportsDeveloperRole: false
      }

    }))

  });

  // ---------------------------------------------------------------------------
  // Outgoing payload normalization.
  //
  // 1. content: Sarvam requires message.content to be a string, but pi sends
  //    user/multimodal content as an array of parts (e.g. [{type:"text",...}]).
  //    No compat flag covers this. Models here are text-only, so joining the
  //    text parts and dropping the rest is safe.
  // 2. role: `compat.supportsDeveloperRole: false` already makes pi emit `system`
  //    instead of `developer`. The remap below is a cheap safety net in case any
  //    `developer` role still slips through.
  // 3. size: Sarvam's gateway returns 403 for request bodies >= 256 KB (verified:
  //    255 KB -> 200, 262 KB -> 403). Long sessions cross this and then fail every
  //    turn deterministically. Keep the body under the limit by stubbing older
  //    message content and, when the message COUNT alone is too large, dropping the
  //    oldest turns (cut at a user boundary so tool calls/results stay paired).
  //    Non-destructive — only the outgoing request is trimmed; the session file
  //    keeps the full history.
  // ---------------------------------------------------------------------------
  const MAX_BODY = 250 * 1024;            // safety margin under the 256 KB ceiling
  const KEEP_RECENT = 8;                  // never stub the last N messages
  const STUB = "[older output truncated to fit Sarvam's 256KB request limit]";
  const bodySize = (o: unknown) => Buffer.byteLength(JSON.stringify(o));

  // Applied from two places, because pi has two request paths (see the onPayload
  // injection in streamWithRetry below): the `before_provider_request` hook covers
  // normal turns, and an injected `options.onPayload` covers compaction/branch
  // summarization, which never fires the hook. Idempotent — a second pass sees
  // string content and returns it unchanged — so double application is harmless.
  const normalizeSarvamPayload = (payload: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (!Array.isArray(payload?.messages)) return;

    const messages: Array<Record<string, unknown>> = (payload.messages as Array<Record<string, unknown>>).map(msg => {
      const role = msg.role === "developer" ? "system" : msg.role;
      if (!Array.isArray(msg.content)) return { ...msg, role };

      const text = (msg.content as Array<{ type?: string; text?: string }>)
        .filter(p => p.type === "text" || typeof p.text === "string")
        .map(p => p.text ?? "")
        .join("");

      providerMetrics.contentTransformations++;
      return { ...msg, role, content: text };
    });

    let result: Record<string, unknown> = { ...payload, messages };
    if (bodySize(result) > MAX_BODY) {
      providerMetrics.sizeGuardTriggers++;

      // Keep leading system message(s) intact.
      let sysCount = 0;
      while (sysCount < messages.length && messages[sysCount].role === "system") sysCount++;
      const sys = messages.slice(0, sysCount);
      let rest = messages.slice(sysCount).map(m => ({ ...m }));

      // 1) Stub content (and old tool_call args) of all but the most recent KEEP_RECENT.
      const recentStart = Math.max(0, rest.length - KEEP_RECENT);
      for (let i = 0; i < recentStart; i++) {
        const m = rest[i];
        if (typeof m.content === "string" && m.content.length > STUB.length) m.content = STUB;
        if (Array.isArray(m.tool_calls)) {
          m.tool_calls = (m.tool_calls as Array<Record<string, any>>).map(tc => ({
            ...tc, function: { ...(tc.function ?? {}), arguments: "{}" },
          }));
        }
      }

      // 2) Stubbing can't help when the message COUNT dominates (per-message JSON +
      //    tool-call ids). Drop the oldest turns, cutting at a user-message boundary
      //    so no tool message is orphaned and no tool_call is left dangling.
      const base = bodySize({ ...payload, messages: sys });
      const restBytes = rest.reduce((a, m) => a + bodySize(m) + 1, 0);
      if (base + restBytes > MAX_BODY) {
        let acc = 0, start = rest.length;
        for (let i = rest.length - 1; i >= 0; i--) {
          acc += bodySize(rest[i]) + 1;
          if (base + acc > MAX_BODY) { start = i + 1; break; }
          start = i;
        }
        while (start < rest.length && rest[start].role !== "user") start++;
        if (start >= rest.length) {
          // No user boundary at or after the budget cut. Slicing by message count
          // instead could land on a `tool` message — orphaned, since its
          // tool_call would be gone — which the endpoint rejects outright. Keep
          // the last user turn even though it busts the budget; the hard cap
          // below shrinks it. With no user message at all, keep nothing.
          let lastUser = -1;
          for (let i = rest.length - 1; i >= 0; i--) {
            if (rest[i].role === "user") { lastUser = i; break; }
          }
          start = lastUser >= 0 ? lastUser : rest.length;
        }
        rest = rest.slice(start);
      }

      result = { ...payload, messages: [...sys, ...rest] };

      // 3) Last resort (huge recent turns): hard-cap remaining content. Tool-call
      //    arguments count too — a recent `write` carrying a whole file body lives
      //    entirely in tool_calls[].function.arguments, which step 1 only stubs for
      //    OLDER messages, so capping content alone leaves the body oversized.
      //    Arguments are a JSON string: blank them rather than slicing, since a
      //    truncated one is invalid JSON.
      if (bodySize(result) > MAX_BODY) {
        const CAP = 6000;
        const ARG_CAP = 4000;
        for (const m of rest) {
          if (m.role !== "system" && typeof m.content === "string" && m.content.length > CAP) {
            m.content = m.content.slice(0, CAP) + "\n…[truncated]";
          }
          if (Array.isArray(m.tool_calls)) {
            m.tool_calls = (m.tool_calls as Array<Record<string, any>>).map(tc =>
              typeof tc.function?.arguments === "string" && tc.function.arguments.length > ARG_CAP
                ? { ...tc, function: { ...tc.function, arguments: "{}" } }
                : tc
            );
          }
        }
        result = { ...payload, messages: [...sys, ...rest] };
      }
    }

    return result;
  };

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "sarvam") return;
    return normalizeSarvamPayload(event.payload as Record<string, unknown>);
  });

  // ---------------------------------------------------------------------------
  // Editing guidance.
  //
  // The smaller Sarvam models struggle with exact-match editing: the
  // edit tool requires oldText to match the file byte-for-byte, which weaker
  // models often get wrong (indentation, stale context), so edits silently fail
  // to apply. Append concrete rules to the system prompt (sarvam only).
  // ---------------------------------------------------------------------------
  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.model?.provider !== "sarvam") return;

    const guidance = [
      "File editing rules (follow strictly):",
      "- Before editing, read the exact region you will change and copy the to-be-replaced text verbatim, including leading whitespace/indentation. Edits are matched exactly (after line-ending normalization) — a single wrong space fails the match.",
      "- Keep the matched snippet short but unique; do not pad it with large unchanged regions.",
      "- To change several places in one file, send ONE edit call with multiple replacements rather than many separate edits.",
      "- Never assume an edit applied. Read the tool result; if it reports no match, re-read the file and retry with the exact current text instead of guessing.",
      "- For a new file, or when rewriting most of a file, use the write tool with the full contents instead of many edits.",
    ].join("\n");

    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });

  debugLog("Provider initialized successfully");
  process.on("exit", debugMetrics);

}
