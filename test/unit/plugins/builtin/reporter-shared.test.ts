import { describe, expect, test } from "bun:test";
import { mockFetch } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { interpolateHeaders, type PostJsonDeps, postJson } from "@/plugins";

/** Run `fn` with a fresh logger whose redacted entries are captured, then restore. */
async function withCapturedLogs<T>(fn: (entries: LogEntry[]) => Promise<T>): Promise<T> {
  const entries: LogEntry[] = [];
  resetLogger();
  initLogger({ level: "silent" });
  const unsubscribe = addSink((entry) => entries.push(entry));
  try {
    return await fn(entries);
  } finally {
    unsubscribe();
    resetLogger();
  }
}

describe("interpolateHeaders", () => {
  test("resolves a single env placeholder", () => {
    const { resolved, missing } = interpolateHeaders({ Authorization: `Bearer \${TOK}` }, { TOK: "abc" });
    expect(resolved.Authorization).toBe("Bearer abc");
    expect(missing).toEqual([]);
  });

  test("resolves multiple placeholders across headers", () => {
    const { resolved, missing } = interpolateHeaders({ A: `\${X}`, B: `p-\${Y}-q` }, { X: "1", Y: "2" });
    expect(resolved).toEqual({ A: "1", B: "p-2-q" });
    expect(missing).toEqual([]);
  });

  test("reports missing env vars without throwing", () => {
    const { missing } = interpolateHeaders({ A: `\${GONE}` }, {});
    expect(missing).toEqual(["GONE"]);
  });

  test("passes through literal values untouched", () => {
    const { resolved, missing } = interpolateHeaders({ A: "plain" }, {});
    expect(resolved.A).toBe("plain");
    expect(missing).toEqual([]);
  });
});

describe("postJson", () => {
  const okFetch: PostJsonDeps["fetch"] = mockFetch(async () => new Response(null, { status: 200 }));

  test("returns true and POSTs JSON with merged headers on 2xx", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const deps: PostJsonDeps = {
      fetch: mockFetch(async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(null, { status: 204 });
      }),
    };
    const ok = await postJson(
      "https://h/x",
      { a: 1 },
      {
        headers: { "X-Api": "k" },
        timeoutMs: 1000,
        stage: "test",
        deps,
      },
    );
    expect(ok).toBe(true);
    expect(capturedUrl).toBe("https://h/x");
    expect(capturedInit?.method).toBe("POST");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-api")).toBe("k");
    expect(capturedInit?.body).toBe(JSON.stringify({ a: 1 }));
  });

  test("returns false on non-2xx", async () => {
    const deps: PostJsonDeps = { fetch: mockFetch(async () => new Response(null, { status: 500 })) };
    const ok = await postJson(
      "https://h/x",
      {},
      {
        headers: {},
        timeoutMs: 1000,
        stage: "test",
        deps,
      },
    );
    expect(ok).toBe(false);
  });

  test("returns false when fetch throws (network/timeout)", async () => {
    const deps: PostJsonDeps = {
      fetch: mockFetch(async () => {
        throw new Error("boom");
      }),
    };
    const ok = await postJson(
      "https://h/x",
      {},
      {
        headers: {},
        timeoutMs: 1000,
        stage: "test",
        deps,
      },
    );
    expect(ok).toBe(false);
  });

  test("SEC-2: logs the webhook origin and a hash, never the full URL, on non-2xx", async () => {
    await withCapturedLogs(async (entries) => {
      const slackUrl = [
        "https://hooks.slack.com",
        "services",
        "T00000000",
        "B00000000",
        "XXXXXXXXXXXXXXXXXXXXXXXX",
      ].join("/");
      const deps: PostJsonDeps = { fetch: mockFetch(async () => new Response(null, { status: 500 })) };
      const ok = await postJson(slackUrl, {}, { headers: {}, timeoutMs: 1000, stage: "test", deps });
      expect(ok).toBe(false);

      const entry = entries.find((e) => e.stage === "test");
      expect(entry).toBeDefined();
      const payload = JSON.stringify(entry?.data);
      expect(payload).not.toContain(slackUrl);
      expect(payload).not.toContain("T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX");
      expect(payload).toContain("https://hooks.slack.com");
      expect(payload).toContain("urlHash");
    });
  });

  test("SEC-2: logs the webhook origin and a hash, never the full URL, when fetch throws", async () => {
    await withCapturedLogs(async (entries) => {
      const slackUrl = [
        "https://hooks.slack.com",
        "services",
        "T00000000",
        "B00000000",
        "XXXXXXXXXXXXXXXXXXXXXXXX",
      ].join("/");
      const deps: PostJsonDeps = {
        fetch: mockFetch(async () => {
          throw new Error("boom");
        }),
      };
      const ok = await postJson(slackUrl, {}, { headers: {}, timeoutMs: 1000, stage: "test", deps });
      expect(ok).toBe(false);

      const entry = entries.find((e) => e.stage === "test");
      expect(entry).toBeDefined();
      const payload = JSON.stringify(entry?.data);
      expect(payload).not.toContain(slackUrl);
      expect(payload).toContain("https://hooks.slack.com");
    });
  });

  test("SEC-2: a malformed configured URL logs a hash without throwing", async () => {
    await withCapturedLogs(async (entries) => {
      const deps: PostJsonDeps = { fetch: mockFetch(async () => new Response(null, { status: 500 })) };
      const ok = await postJson("not-a-url", {}, { headers: {}, timeoutMs: 1000, stage: "test", deps });
      expect(ok).toBe(false);

      const entry = entries.find((e) => e.stage === "test");
      expect(entry).toBeDefined();
      expect(JSON.stringify(entry?.data)).toContain("urlHash");
    });
  });

  test("uses the ok fetch by default deps arg", async () => {
    const ok = await postJson(
      "https://h/x",
      {},
      {
        headers: {},
        timeoutMs: 1000,
        stage: "test",
        deps: { fetch: okFetch },
      },
    );
    expect(ok).toBe(true);
  });
});
