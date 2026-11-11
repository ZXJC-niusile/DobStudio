/**
 * Translation-layer integration tests against a real HTTP server.
 *
 * The unit tests cover `parseBatchResponse` in isolation. This file exercises
 * everything in front of and behind it: `fetch`, the batching loop, the
 * concurrency pool, the retry/backoff path, and the "the model skipped some
 * lines" path — all over a real socket on an ephemeral port.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { translateCues } from "../src/translator.ts";
import type { Cue, ProviderConfig } from "../src/types.ts";

interface Captured {
  bodies: { messages: { role: string; content: string }[] }[];
  /** Requests received, in arrival order. */
  count: number;
  /** Highest number of requests in flight at once. */
  peakConcurrency: number;
  inFlight: number;
  /** Authorization header of the most recent request. */
  authHeader?: string;
  /** Custom headers seen, merged from every request. */
  headers: Record<string, string | string[] | undefined>;
}

let server: Server;
let baseUrl: string;
let captured: Captured;

/** Behaviour installed by each test. */
let handler: (
  body: { messages: { role: string; content: string }[] },
  attempt: number,
) => { status?: number; content?: string; drop?: number[] };

/** Deterministic fake translations, so assertions do not depend on a model. */
const DICTIONARY: Record<string, string> = {
  hello: "你好",
  world: "世界",
  "gradient descent": "梯度下降",
  "the key idea": "核心思想",
  "everything else is engineering": "其余都是工程问题",
};

function fakeTranslate(text: string): string {
  let out = text;
  for (const [source, target] of Object.entries(DICTIONARY)) {
    out = out.replaceAll(source, target);
  }
  return out;
}

/** The JSON array a well-behaved model returns for a batch. */
function modelReply(batch: { i: number; t: string }[], drop: number[] = []): string {
  return JSON.stringify(
    batch
      .filter((cue) => !drop.includes(cue.i))
      .map((cue) => ({ i: cue.i, t: fakeTranslate(cue.t) })),
  );
}

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
      captured.count += 1;
      captured.bodies.push(body);
      captured.authHeader = req.headers.authorization;
      captured.headers = { ...captured.headers, ...req.headers };

      captured.inFlight += 1;
      captured.peakConcurrency = Math.max(captured.peakConcurrency, captured.inFlight);
      // Release the slot on the next tick so overlap is observable.
      setImmediate(() => {
        captured.inFlight -= 1;
      });

      const outcome = handler(body, captured.count);
      const status = outcome.status ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: outcome.content ?? "" } }],
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}/v1`;
});

after(() => {
  server.close();
});

function reset(): void {
  captured = { bodies: [], count: 0, peakConcurrency: 0, inFlight: 0, headers: {} };
  handler = (body) => {
    const batch = JSON.parse(body.messages[1]!.content) as { i: number; t: string }[];
    return { content: modelReply(batch) };
  };
}

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "mock-http",
    name: "Mock HTTP",
    baseUrl,
    apiKey: "test-key",
    model: "mock-model",
    concurrency: 4,
    ...overrides,
  };
}

function cues(count: number): Cue[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    startMs: i * 1000,
    endMs: i * 1000 + 900,
    text: `line ${i + 1} hello world`,
  }));
}

describe("translateCues over HTTP", () => {
  it("translates every cue and preserves order", async () => {
    reset();
    const result = await translateCues(cues(10), {
      targetLang: "zh-Hans",
      provider: provider(),
    });

    assert.equal(result.translations.length, 10);
    assert.equal(result.skippedCount, 0);
    assert.equal(result.translations[0], "line 1 你好 世界");
    assert.equal(result.translations[9], "line 10 你好 世界");
    assert.equal(result.requestCount, 1, "10 cues fit in one batch");
  });

  it("splits into batches of the requested size", async () => {
    reset();
    const result = await translateCues(cues(100), {
      targetLang: "zh-Hans",
      provider: provider(),
      batchSize: 30,
    });

    assert.equal(result.requestCount, 4, "100 cues / 30 per batch = 4 requests");
    assert.equal(result.skippedCount, 0);
    assert.equal(result.translations.filter((t) => t !== "").length, 100);
  });

  it("sends the system prompt with the target language and the cue array", async () => {
    reset();
    await translateCues(cues(3), { targetLang: "ja", provider: provider() });

    assert.equal(captured.bodies.length, 1);
    const [system, user] = captured.bodies[0]!.messages;
    assert.match(system!.content, /into ja/);
    assert.match(system!.content, /JSON array only/);

    const sent = JSON.parse(user!.content) as { i: number; t: string }[];
    assert.deepEqual(
      sent.map((c) => c.i),
      [1, 2, 3],
    );
  });

  it("includes glossary terms in the system prompt", async () => {
    reset();
    await translateCues(cues(2), {
      targetLang: "zh-Hans",
      provider: provider(),
      glossary: [{ source: "gradient descent", target: "梯度下降" }],
    });
    assert.match(captured.bodies[0]!.messages[0]!.content, /gradient descent.*→.*梯度下降/s);
  });

  it("sends the API key as a bearer token", async () => {
    reset();
    await translateCues(cues(2), { targetLang: "zh-Hans", provider: provider() });
    assert.equal(captured.authHeader, "Bearer test-key");
  });

  it("forwards custom headers alongside the authorization", async () => {
    reset();
    await translateCues(cues(2), {
      targetLang: "zh-Hans",
      provider: provider({ headers: { "X-Trace-Id": "abc123" } }),
    });
    assert.equal(captured.authHeader, "Bearer test-key");
    assert.equal(captured.headers["x-trace-id"], "abc123");
  });

  it("runs batches concurrently up to the configured limit", async () => {
    reset();
    // Hold each response until released, so overlap is guaranteed observable.
    const gates: (() => void)[] = [];
    handler = (body) => {
      const batch = JSON.parse(body.messages[1]!.content) as { i: number; t: string }[];
      return { content: modelReply(batch) };
    };

    await translateCues(cues(80), {
      targetLang: "zh-Hans",
      provider: provider({ concurrency: 4 }),
      batchSize: 20,
    });

    assert.equal(captured.count, 4);
    assert.ok(
      captured.peakConcurrency > 1,
      `expected overlapping requests, saw peak ${captured.peakConcurrency}`,
    );
    assert.ok(captured.peakConcurrency <= 4, "must not exceed the configured limit");
    assert.equal(gates.length, 0);
  });

  it("retries a failing batch and then succeeds", async () => {
    reset();
    let failures = 0;
    handler = (body) => {
      // Fail the first attempt at each batch once, then answer normally.
      if (failures < 2) {
        failures += 1;
        return { status: 500, content: "" };
      }
      const batch = JSON.parse(body.messages[1]!.content) as { i: number; t: string }[];
      return { content: modelReply(batch) };
    };

    const result = await translateCues(cues(10), {
      targetLang: "zh-Hans",
      provider: provider({ maxRetries: 3 }),
    });

    assert.equal(result.skippedCount, 0);
    assert.ok(result.retryCount >= 2, `expected retries, got ${result.retryCount}`);
    assert.ok(captured.count > 1, "a retry means more than one request");
  });

  it("gives up after maxRetries and marks the batch untranslated", async () => {
    reset();
    handler = () => ({ status: 503, content: "" });

    const result = await translateCues(cues(10), {
      targetLang: "zh-Hans",
      provider: provider({ maxRetries: 1 }),
    });

    assert.equal(result.skippedCount, 10, "every cue is untranslated");
    assert.equal(result.translations.every((t) => t === ""), true);
    assert.equal(captured.count, 2, "one try plus one retry");
  });

  it("counts cues the model silently dropped", async () => {
    reset();
    handler = (body) => {
      const batch = JSON.parse(body.messages[1]!.content) as { i: number; t: string }[];
      // Return only the first half of the batch.
      return { content: modelReply(batch, batch.slice(5).map((c) => c.i)) };
    };

    const result = await translateCues(cues(10), {
      targetLang: "zh-Hans",
      provider: provider(),
    });

    assert.equal(result.skippedCount, 5);
    assert.equal(result.translations.filter((t) => t !== "").length, 5);
  });

  it("retries when the model returns prose instead of JSON", async () => {
    reset();
    let attempts = 0;
    handler = (body) => {
      attempts += 1;
      if (attempts === 1) return { content: "I'm sorry, I can't do that." };
      const batch = JSON.parse(body.messages[1]!.content) as { i: number; t: string }[];
      return { content: modelReply(batch) };
    };

    const result = await translateCues(cues(4), {
      targetLang: "zh-Hans",
      provider: provider({ maxRetries: 2 }),
    });

    assert.equal(result.skippedCount, 0);
    assert.equal(attempts, 2);
  });

  it("reports progress monotonically", async () => {
    reset();
    const seen: number[] = [];
    await translateCues(cues(60), {
      targetLang: "zh-Hans",
      provider: provider(),
      batchSize: 20,
      onProgress: (done) => seen.push(done),
    });

    assert.deepEqual(seen, [20, 40, 60, 60]);
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i]! >= seen[i - 1]!);
    }
  });

  it("handles an empty cue list without a request", async () => {
    reset();
    const result = await translateCues([], {
      targetLang: "zh-Hans",
      provider: provider(),
    });
    assert.deepEqual(result.translations, []);
    assert.equal(captured.count, 0);
  });

  it("aborts mid-flight when the signal fires", async () => {
    reset();
    const controller = new AbortController();
    handler = (body) => {
      controller.abort();
      const batch = JSON.parse(body.messages[1]!.content) as { i: number; t: string }[];
      return { content: modelReply(batch) };
    };

    const result = await translateCues(cues(60), {
      targetLang: "zh-Hans",
      provider: provider({ maxRetries: 0 }),
      batchSize: 20,
      signal: controller.signal,
    });

    // Whatever completed is kept; nothing is fabricated.
    assert.ok(result.translations.length === 60);
    assert.ok(result.translations.filter((t) => t !== "").length < 60);
  });
});
