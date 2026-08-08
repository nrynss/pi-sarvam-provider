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
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  errorEvent,
  normalizeSarvamPayload,
  remapPath,
  sanitizeModelFields,
  shouldRetry,
  sleep,
} from "./sarvam.ts";

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
    // mode only applies when the file is *created*; enforce 600 unconditionally so
    // the key-hash-carrying file never inherits looser permissions from a stale
    // predecessor or an over-permissive umask.
    chmodSync(CACHE_FILE, 0o600);
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

  const readDef = createReadToolDefinition(cwd);
  readDef.prepareArguments = (args: unknown) => {
    // Models occasionally emit arguments as a JSON string or a bare array. Spreading
    // a string yields index-keyed garbage ({0:'a',1:'b'}) and an array would too;
    // leave both untouched so schema validation reports the real shape instead.
    if (typeof args !== "object" || args === null || Array.isArray(args)) return args as never;
    const a = { ...(args as Record<string, unknown>) };
    remapPath(a);
    return a as never;
  };
  pi.registerTool(readDef);

  const writeDef = createWriteToolDefinition(cwd);
  writeDef.prepareArguments = (args: unknown) => {
    if (typeof args !== "object" || args === null || Array.isArray(args)) return args as never;
    const a = { ...(args as Record<string, unknown>) };
    remapPath(a);
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
    if (typeof args !== "object" || args === null || Array.isArray(args)) return args as never;
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

  // Retry-After, via pi's implementation rather than a second one.
  //
  // pi-ai's `retryProviderRequest` already honours `retry-after-ms` and
  // `retry-after` (delta-seconds and HTTP-date), caps a server-requested wait at
  // `maxRetryDelayMs` (60s default), and otherwise backs off exponentially with
  // jitter. It is inert unless `maxRetries > 0`, and pi leaves
  // `retry.provider.maxRetries` unset — so out of the box nothing honours Retry-After,
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
  // (`sleep` is imported from ./sarvam.ts.)

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
        const normalized = normalize(current) ?? current;
        mergeNormalizeCounters();
        return normalized;
      },
    };
  };

  const streamWithRetry = (model: any, context: any, options: any): any => {
    const startTime = Date.now();
    const out = createAssistantMessageEventStream();

    void (async () => {
      for (let attempt = 0; ; attempt++) {
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
    // /v1/models is subject to the same intermittent gateway 403s as completions
    // (verified live: the same request answers 200 and 403 across attempts), so
    // retry transient failures on a short ladder — but fail fast on an
    // invalid_api_key_error body, which is permanent and needs no retrying.
    const DISCOVERY_DELAYS_MS = [500, 1500];
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(
          `${BASE_URL}/models`,
          {
            headers: {
              Authorization: `Bearer ${apiKey}`
            },
            // A hung gateway must not stall pi's startup: without a timeout, activate()
            // blocks indefinitely and the session comes up with no provider at all.
            signal: AbortSignal.timeout(10000)
          }
        );

        if (response.ok) {
          models = (await response.json()) as ModelResponse;
          break;
        }

        const detail = (await response.text().catch(() => "")).slice(0, 300).trim();
        const reason = `HTTP ${response.status} ${response.statusText}. ${detail}`;
        if (attempt < DISCOVERY_DELAYS_MS.length && shouldRetry(reason)) {
          debugLog(`Discovery HTTP ${response.status}, retrying in ${DISCOVERY_DELAYS_MS[attempt]}ms`);
          await sleep(DISCOVERY_DELAYS_MS[attempt]!);
          continue;
        }
        console.warn(
          `Sarvam: could not list models — ${reason}` +
          `${response.status === 401 || response.status === 403 ? " Check SARVAM_API_KEY." : ""}`
        );
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < DISCOVERY_DELAYS_MS.length && shouldRetry(msg)) {
          debugLog(`Discovery error, retrying in ${DISCOVERY_DELAYS_MS[attempt]}ms: ${msg}`);
          await sleep(DISCOVERY_DELAYS_MS[attempt]!);
          continue;
        }
        modelMetrics.errors++;
        console.warn(
          `Sarvam: could not reach ${BASE_URL}/models — ${msg}`
        );
        return;
      }
    }

    modelMetrics.apiCalls++;
    debugLog(`Successfully fetched ${models.data.length} models from API`);

    // Cache the successful response for the next pi launch
    writeCachedModels(apiKey, BASE_URL, models);
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

    models: models.data.map(model => {

      // A 0, NaN, or non-numeric context_window would register a degenerate window
      // (pi compacts every turn or never), and a bogus max_tokens could make every
      // request fail with a 400. Sanitize to safe fallbacks.
      const { contextWindow, maxTokens } = sanitizeModelFields(model);

      return {

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
        contextWindow,

        maxTokens,

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

      };
    })

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
  //
  // The implementation lives in ./sarvam.ts; the counters here feed its debug
  // metrics. Applied from two places, because pi has two request paths (see the
  // onPayload injection in streamWithRetry below): the `before_provider_request`
  // hook covers normal turns, and an injected `options.onPayload` covers
  // compaction/branch summarization, which never fires the hook. Idempotent — a
  // second pass sees string content and returns it unchanged — so double
  // application is harmless.
  // ---------------------------------------------------------------------------
  const normalizeCounters = { contentTransformations: 0, sizeGuardTriggers: 0 };
  const normalize = (payload: Record<string, unknown>) =>
    normalizeSarvamPayload(payload, normalizeCounters);
  // The accumulator is reset after merging: both the `before_provider_request` hook
  // and the injected options.onPayload normalize the same request (pass 2 is an
  // idempotent no-op but still calls merge), so a stale accumulator would double-count.
  const mergeNormalizeCounters = () => {
    providerMetrics.contentTransformations += normalizeCounters.contentTransformations;
    providerMetrics.sizeGuardTriggers += normalizeCounters.sizeGuardTriggers;
    normalizeCounters.contentTransformations = 0;
    normalizeCounters.sizeGuardTriggers = 0;
  };

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "sarvam") return;
    const result = normalize(event.payload as Record<string, unknown>);
    mergeNormalizeCounters();
    return result;
  });

  // Tool-call metrics. Counted here rather than in the prepareArguments shims
  // (which also run for other providers — the tool registration is global), so the
  // counters only reflect sarvam traffic.
  pi.on("tool_call", (event, ctx) => {
    if (ctx.model?.provider !== "sarvam") return;
    if (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit") return;
    providerMetrics.toolCalls++;
    providerMetrics.toolCallTypes[event.toolName] = (providerMetrics.toolCallTypes[event.toolName] || 0) + 1;
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
