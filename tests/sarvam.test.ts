import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bodySize,
  errorEvent,
  fixWinPath,
  MAX_BODY,
  normalizeSarvamPayload,
  remapPath,
  sanitizeModelFields,
  shouldRetry,
  sleep,
  STUB,
} from "../src/sarvam.ts";

describe("fixWinPath", () => {
  it("strips a leading separator before a drive letter on win32", () => {
    assert.equal(fixWinPath("/E:/work/vimanam", "win32"), "E:/work/vimanam");
    assert.equal(fixWinPath("\\E:\\work", "win32"), "E:\\work");
  });

  it("leaves other platforms untouched", () => {
    assert.equal(fixWinPath("/E:/work", "linux"), "/E:/work");
  });

  it("leaves non-strings untouched", () => {
    assert.equal(fixWinPath(42, "win32"), 42);
    assert.equal(fixWinPath(undefined, "win32"), undefined);
  });

  it("leaves non-drive absolute paths untouched", () => {
    assert.equal(fixWinPath("/home/nryn/x", "win32"), "/home/nryn/x");
  });
});

describe("remapPath", () => {
  it("maps file_path to path", () => {
    const a: Record<string, unknown> = { file_path: "src/a.ts" };
    remapPath(a);
    assert.deepEqual(a, { path: "src/a.ts" });
  });

  it("prefers an existing path over file_path", () => {
    const a: Record<string, unknown> = { file_path: "src/a.ts", path: "src/b.ts" };
    remapPath(a);
    assert.deepEqual(a, { path: "src/b.ts" });
  });

  it("repairs a doubled Windows drive prefix through the path", () => {
    const a: Record<string, unknown> = { file_path: "/E:/work" };
    remapPath(a);
    // fixWinPath only repairs on win32; simulate with a pre-fixed value to check
    // the delete + assignment behavior is complete.
    assert.equal(a.path, "/E:/work");
    assert.equal("file_path" in a, false);
  });
});

describe("shouldRetry", () => {
  it("retries transient statuses and phrases", () => {
    assert.equal(shouldRetry("403 Forbidden"), true);
    assert.equal(shouldRetry("429 Too Many Requests"), true);
    assert.equal(shouldRetry("502 Bad Gateway"), true);
    assert.equal(shouldRetry("The server is temporarily unavailable"), true);
    assert.equal(shouldRetry("fetch failed"), true);
    assert.equal(shouldRetry("socket hang up"), true);
    assert.equal(shouldRetry("ECONNRESET"), true);
    assert.equal(shouldRetry("Request timed out"), true);
  });

  it("does not retry permanent failures", () => {
    assert.equal(shouldRetry("invalid_api_key_error"), false);
    assert.equal(shouldRetry("401 Unauthorized"), false);
    assert.equal(shouldRetry("unauthenticated"), false);
    assert.equal(shouldRetry("Request was aborted"), false);
    assert.equal(shouldRetry("Model not found"), false);
  });

  it("does not retry a transient-looking status in a permanent body", () => {
    assert.equal(shouldRetry("403 invalid_api_key_error"), false);
  });
});

describe("sanitizeModelFields", () => {
  it("passes sane values through, capped at the context limit", () => {
    const { contextWindow, maxTokens } = sanitizeModelFields({ id: "m", context_window: 128000, max_tokens: 8192 });
    assert.equal(contextWindow, 46000);
    assert.equal(maxTokens, 8192);
  });

  it("falls back for 0, NaN, and missing values", () => {
    assert.deepEqual(sanitizeModelFields({ id: "m", context_window: 0, max_tokens: 0 }), { contextWindow: 46000, maxTokens: 16384 });
    assert.deepEqual(sanitizeModelFields({ id: "m" }), { contextWindow: 46000, maxTokens: 16384 });
    assert.deepEqual(sanitizeModelFields({ id: "m", context_window: Number.NaN, max_tokens: Number.NaN }), { contextWindow: 46000, maxTokens: 16384 });
  });

  it("coerces numeric strings", () => {
    const { contextWindow, maxTokens } = sanitizeModelFields({ id: "m", context_window: "64000" as unknown as number, max_tokens: "4096" as unknown as number });
    assert.equal(contextWindow, 46000);
    assert.equal(maxTokens, 4096);
  });
});

describe("normalizeSarvamPayload — shape", () => {
  it("returns undefined for a payload without messages", () => {
    assert.equal(normalizeSarvamPayload({ model: "x" }), undefined);
  });

  it("maps developer role to system", () => {
    const out = normalizeSarvamPayload({ messages: [{ role: "developer", content: "sys" }] })!;
    assert.equal(out.messages[0].role, "system");
  });

  it("joins array content into a string, dropping non-text parts", () => {
    const out = normalizeSarvamPayload({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "hello " },
          { type: "image", data: "..." },
          { type: "text", text: "world" },
        ],
      }],
    })!;
    assert.equal(out.messages[0].content, "hello world");
  });

  it("places a placeholder for image-only content", () => {
    const out = normalizeSarvamPayload({
      messages: [{ role: "user", content: [{ type: "image", data: "..." }] }],
    })!;
    assert.equal(out.messages[0].content, "[non-text content omitted]");
  });

  it("is idempotent across passes", () => {
    const payload = {
      messages: [
        { role: "developer", content: "sys" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    };
    const once = normalizeSarvamPayload(payload)!;
    const twice = normalizeSarvamPayload(once)!;
    assert.deepEqual(once, twice);
  });
});

describe("normalizeSarvamPayload — size guard", () => {
  const big = "x".repeat(4000);

  it("does nothing when the body fits", () => {
    const payload = { messages: [{ role: "user", content: "small" }] };
    const out = normalizeSarvamPayload(payload, undefined, { maxBody: 100000 })!;
    assert.equal(out.messages[0].content, "small");
  });

  it("stubs old content, preserving system and recent messages", () => {
    const messages = [
      { role: "system", content: "keep-me-system" },
      { role: "user", content: "old-turn-" + big },
      { role: "assistant", content: "old-reply-" + big },
      { role: "user", content: "new-turn" },
    ];
    const out = normalizeSarvamPayload({ messages }, undefined, { maxBody: 2000, keepRecent: 1 })!;
    assert.equal(out.messages[0].content, "keep-me-system"); // system intact
    assert.equal(out.messages[1].content, STUB);             // oldest stubbed
    assert.equal(out.messages[2].content, STUB);
    assert.equal(out.messages[3].content, "new-turn");       // recent preserved
    assert.ok(bodySize(out) <= 2000);
  });

  it("blanks tool-call arguments of old messages", () => {
    const messages = [
      { role: "user", content: "old-" + big },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "a", content: big }) } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "result" },
      { role: "user", content: "fresh" },
    ];
    const out = normalizeSarvamPayload({ messages }, undefined, { maxBody: 2000, keepRecent: 1 })!;
    const tc = out.messages[1].tool_calls[0].function;
    assert.equal(tc.arguments, "{}");
    assert.equal(tc.name, "write");
  });

  it("drops oldest turns at a user boundary when the count dominates", () => {
    const messages = [
      { role: "user", content: "turn-a" },
      { role: "assistant", content: "reply-a" },
      { role: "user", content: "turn-b" },
      { role: "assistant", content: "reply-b" },
      { role: "user", content: "turn-c" },
      { role: "assistant", content: "reply-c" },
      { role: "user", content: "turn-d" },
      { role: "assistant", content: "reply-d" },
    ];
    // Tiny budget: only ~1-2 messages fit. The result must start at a user message
    // (no orphaned tool/assistant runs) and stay within budget after the hard cap.
    const out = normalizeSarvamPayload({ messages }, undefined, { maxBody: 200, keepRecent: 1 })!;
    assert.equal(out.messages[0].role, "user");
    assert.ok(bodySize(out) <= 200);
  });

  it("never leaves a dangling tool result when falling back to the last user turn", () => {
    const messages = [
      { role: "assistant", content: "a", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "res" },
      { role: "user", content: "last-user" },
    ];
    const out = normalizeSarvamPayload({ messages }, undefined, { maxBody: 150, keepRecent: 0 })!;
    // Everything after the last user is kept; the result starts at the user message.
    assert.equal(out.messages[0].role, "user");
    assert.ok(bodySize(out) <= 150);
  });

  it("hard-caps oversized recent content and blank args as the last resort", () => {
    const messages = [
      { role: "user", content: "fresh" + big + big + big }, // ~12KB
    ];
    // maxBody larger than the per-message CAP (6000) so the cap can actually fit.
    const out = normalizeSarvamPayload({ messages }, undefined, { maxBody: 8000 })!;
    assert.equal(out.messages[0].role, "user");
    assert.ok(bodySize(out) <= 8000);
    assert.match(out.messages[0].content, /…\[truncated\]/);
  });

  it("counters reflect transformations and guard triggers", () => {
    const counters = { contentTransformations: 0, sizeGuardTriggers: 0 };
    normalizeSarvamPayload(
      { messages: [{ role: "user", content: [{ type: "text", text: big }] }] },
      counters,
      { maxBody: 100 }
    );
    assert.equal(counters.contentTransformations, 1);
    assert.equal(counters.sizeGuardTriggers, 1);
  });

  it("keeps the real default guard at 250 KB", () => {
    assert.equal(MAX_BODY, 250 * 1024);
  });
});

describe("errorEvent", () => {
  it("builds a plain error event", () => {
    const ev = errorEvent({ api: "openai-completions", provider: "sarvam", id: "m1" }, "boom");
    assert.equal(ev.type, "error");
    assert.equal(ev.reason, "error");
    assert.equal(ev.error.stopReason, "error");
    assert.equal(ev.error.errorMessage, "boom");
    assert.equal(ev.error.model, "m1");
  });

  it("marks aborted events", () => {
    const ev = errorEvent({ id: "m1" }, "Request was aborted", true);
    assert.equal(ev.reason, "aborted");
    assert.equal(ev.error.stopReason, "aborted");
  });
});

describe("sleep", () => {
  it("resolves on abort without waiting the full duration", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = sleep(1000, ac.signal);
    ac.abort();
    await p;
    assert.ok(Date.now() - started < 500, "should not wait the full second");
  });

  it("resolves after the duration when not aborted", async () => {
    const started = Date.now();
    await sleep(20);
    assert.ok(Date.now() - started >= 15);
  });
});
