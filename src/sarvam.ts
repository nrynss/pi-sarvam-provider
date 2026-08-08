/**
 * Pure compatibility logic for the Sarvam provider shims.
 *
 * Everything in this module is side-effect free (no I/O, no process globals
 * except `process.platform` captured via a parameter) so it can be unit-tested
 * without pi or a network. `src/index.ts` wires it into the extension.
 */

// ---------------------------------------------------------------------------
// Transient-error classification
// ---------------------------------------------------------------------------

// Statuses and phrases that indicate a retryable gateway/network blip.
export const TRANSIENT = /\b(403|408|425|429|500|502|503|504)\b|forbidden|too many requests|rate.?limit|overloaded|temporar|unavailable|gateway|fetch failed|network error|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|UND_ERR_|socket closed|timed out|request timeout|connection.*closed|connection refused|\btls\b/i;

// Sarvam returns 403 for BOTH transient gateway blips and a permanently bad key,
// so the status alone can't separate them — the body's error code can. An invalid
// key must not burn the whole backoff ladder.
export const PERMANENT = /invalid_api_key_error|invalid or missing authentication|unauthenticated|unauthorized|\b401\b/i;

export const shouldRetry = (message: string): boolean =>
  TRANSIENT.test(message) && !PERMANENT.test(message);

// ---------------------------------------------------------------------------
// Tool-argument remapping
// ---------------------------------------------------------------------------

/**
 * sarvam models sometimes emit a Windows path with a spurious leading separator
 * before the drive, e.g. "/E:/work/vimanam" or "\E:\work". pi's resolvePath sees
 * that as absolute and path.resolve() re-roots it onto the *current* drive,
 * producing a doubled "E:\E:\work\vimanam" that then fails mkdir/ENOENT. Strip the
 * leading separator so the drive-qualified path resolves cleanly.
 */
export const fixWinPath = (p: unknown, platform: string = process.platform): unknown => {
  if (typeof p !== "string" || platform !== "win32") return p;
  const m = /^[/\\]([A-Za-z]):(.*)$/.exec(p);
  return m ? `${m[1]}:${m[2]}` : p;
};

/** Map Claude-style tool args (file_path) onto pi's schema (path), in place. */
export const remapPath = (a: Record<string, unknown>): void => {
  if (a.file_path != null && a.path == null) a.path = a.file_path;
  delete a.file_path;
  if (typeof a.path === "string") a.path = fixWinPath(a.path);
};

// ---------------------------------------------------------------------------
// Model-field sanitization
// ---------------------------------------------------------------------------

export interface SarvamModel {
  id: string;
  context_window?: number;
  max_tokens?: number;
}

export const MODEL_CONTEXT_CAP = 46000;
export const DEFAULT_MAX_TOKENS = 16384;

/**
 * A 0, NaN, or non-numeric context_window would register a degenerate window
 * (pi compacts every turn or never), and a bogus max_tokens could make every
 * request fail with a 400. Sanitize to safe fallbacks.
 */
export const sanitizeModelFields = (model: SarvamModel): { contextWindow: number; maxTokens: number } => {
  const ctx = Number(model.context_window);
  const contextWindow = Number.isFinite(ctx) && ctx > 0 ? Math.min(ctx, MODEL_CONTEXT_CAP) : MODEL_CONTEXT_CAP;
  const mt = Number(model.max_tokens);
  const maxTokens = Number.isFinite(mt) && mt > 0 ? mt : DEFAULT_MAX_TOKENS;
  return { contextWindow, maxTokens };
};

// ---------------------------------------------------------------------------
// Payload normalization + 256 KB size guard
// ---------------------------------------------------------------------------

export const MAX_BODY = 250 * 1024; // safety margin under the 256 KB ceiling
export const KEEP_RECENT = 8;       // never stub the last N messages
export const STUB = "[older output truncated to fit Sarvam's 256KB request limit]";

export const bodySize = (o: unknown): number => Buffer.byteLength(JSON.stringify(o));

/** Mutable counters the extension feeds into its debug metrics. */
export interface NormalizeCounters {
  contentTransformations: number;
  sizeGuardTriggers: number;
}

/** Overridable limits so the size-guard stages can be exercised in tests cheaply. */
export interface NormalizeOptions {
  maxBody?: number;
  keepRecent?: number;
}

/**
 * 1. content: Sarvam requires message.content to be a string, but pi sends
 *    user/multimodal content as an array of parts (e.g. [{type:"text",...}]).
 *    Models here are text-only, so joining the text parts and dropping the rest
 *    is safe.
 * 2. role: `compat.supportsDeveloperRole: false` already makes pi emit `system`
 *    instead of `developer`. The remap below is a cheap safety net in case any
 *    `developer` role still slips through.
 * 3. size: Sarvam's gateway returns 403 for request bodies >= 256 KB. Long
 *    sessions cross this and then fail every turn deterministically. Keep the
 *    body under the limit by stubbing older message content and, when the
 *    message COUNT alone is too large, dropping the oldest turns (cut at a user
 *    boundary so tool calls/results stay paired). Non-destructive — only the
 *    outgoing request is trimmed; the session file keeps the full history.
 *
 * Idempotent — a second pass sees string content and returns it unchanged.
 * Returns undefined when the payload has no `messages` array.
 */
export const normalizeSarvamPayload = (
  payload: Record<string, unknown>,
  counters?: NormalizeCounters,
  options: NormalizeOptions = {}
): Record<string, unknown> | undefined => {
  if (!Array.isArray(payload?.messages)) return;
  const maxBody = options.maxBody ?? MAX_BODY;
  const keepRecent = options.keepRecent ?? KEEP_RECENT;

  const messages: Array<Record<string, unknown>> = (payload.messages as Array<Record<string, unknown>>).map(msg => {
    const role = msg.role === "developer" ? "system" : msg.role;
    if (!Array.isArray(msg.content)) return { ...msg, role };

    const parts = msg.content as Array<{ type?: string; text?: string }>;
    const text = parts
      .filter(p => p.type === "text" || typeof p.text === "string")
      .map(p => p.text ?? "")
      .join("");

    if (counters) counters.contentTransformations++;

    // Joining text parts drops anything non-text (images etc.). An image-only
    // message would collapse to an empty content string, which some
    // OpenAI-compatible endpoints reject; keep a self-documenting placeholder so
    // the request stays valid and the model knows the content was not textual.
    const content = text.length > 0 || parts.length === 0 ? text : "[non-text content omitted]";
    return { ...msg, role, content };
  });

  let result: Record<string, unknown> = { ...payload, messages };
  if (bodySize(result) > maxBody) {
    if (counters) counters.sizeGuardTriggers++;

    // Keep leading system message(s) intact.
    let sysCount = 0;
    while (sysCount < messages.length && messages[sysCount].role === "system") sysCount++;
    const sys = messages.slice(0, sysCount);
    let rest = messages.slice(sysCount).map(m => ({ ...m }));

    // 1) Stub content (and old tool_call args) of all but the most recent KEEP_RECENT.
    const recentStart = Math.max(0, rest.length - keepRecent);
    for (let i = 0; i < recentStart; i++) {
      const m = rest[i];
      if (typeof m.content === "string" && m.content.length > STUB.length) m.content = STUB;
      if (Array.isArray(m.tool_calls)) {
        m.tool_calls = (m.tool_calls as Array<Record<string, any>>).map(tc => {
          const fn = tc.function;
          return {
            ...tc,
            // `function` is an object in pi's normalized messages, but a raw
            // payload could carry a string (some serializers); spread only objects.
            function: typeof fn === "object" && fn !== null
              ? { ...fn, arguments: "{}" }
              : fn,
          };
        });
      }
    }

    // 2) Stubbing can't help when the message COUNT dominates (per-message JSON +
    //    tool-call ids). Drop the oldest turns, cutting at a user-message boundary
    //    so no tool message is orphaned and no tool_call is left dangling.
    const base = bodySize({ ...payload, messages: sys });
    const restBytes = rest.reduce((a, m) => a + bodySize(m) + 1, 0);
    if (base + restBytes > maxBody) {
      let acc = 0, start = rest.length;
      for (let i = rest.length - 1; i >= 0; i--) {
        acc += bodySize(rest[i]) + 1;
        if (base + acc > maxBody) { start = i + 1; break; }
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
    if (bodySize(result) > maxBody) {
      const CAP = 6000;
      const ARG_CAP = 4000;
      for (const m of rest) {
        if (m.role !== "system" && typeof m.content === "string" && m.content.length > CAP) {
          m.content = m.content.slice(0, CAP) + "\n…[truncated]";
        }
        if (Array.isArray(m.tool_calls)) {
          m.tool_calls = (m.tool_calls as Array<Record<string, any>>).map(tc => {
            const fn = tc.function;
            return typeof fn === "object" && fn !== null &&
              typeof fn.arguments === "string" && fn.arguments.length > ARG_CAP
              ? { ...tc, function: { ...fn, arguments: "{}" } }
              : tc;
          });
        }
      }
      result = { ...payload, messages: [...sys, ...rest] };
    }
  }

  return result;
};

// ---------------------------------------------------------------------------
// Error-event construction
// ---------------------------------------------------------------------------

export interface ErrorEventModel {
  api?: unknown;
  provider?: unknown;
  id?: unknown;
}

/**
 * Build a terminal `error` stream event. pi's event protocol distinguishes
 * aborts from failures: an aborted turn must carry reason/stopReason "aborted"
 * so session metadata records the cancellation rather than an upstream error.
 */
export const errorEvent = (model: ErrorEventModel, message: string, aborted = false) => ({
  type: "error",
  reason: aborted ? "aborted" : "error",
  error: {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: aborted ? "aborted" : "error", errorMessage: message, timestamp: Date.now(),
  },
});

// ---------------------------------------------------------------------------
// Abort-aware sleep
// ---------------------------------------------------------------------------

/** Resolves after `ms`, or immediately when the signal aborts (cleanup included). */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
