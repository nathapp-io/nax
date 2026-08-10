import { describe, expect, test } from "bun:test";
import { type PostJsonDeps, interpolateHeaders, postJson } from "@/plugins";
import { mockFetch } from "@test/helpers";

describe("interpolateHeaders", () => {
  test("resolves a single env placeholder", () => {
    const { resolved, missing } = interpolateHeaders({ Authorization: "Bearer ${TOK}" }, { TOK: "abc" });
    expect(resolved.Authorization).toBe("Bearer abc");
    expect(missing).toEqual([]);
  });

  test("resolves multiple placeholders across headers", () => {
    const { resolved, missing } = interpolateHeaders({ A: "${X}", B: "p-${Y}-q" }, { X: "1", Y: "2" });
    expect(resolved).toEqual({ A: "1", B: "p-2-q" });
    expect(missing).toEqual([]);
  });

  test("reports missing env vars without throwing", () => {
    const { missing } = interpolateHeaders({ A: "${GONE}" }, {});
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
