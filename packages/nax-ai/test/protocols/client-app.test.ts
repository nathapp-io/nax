/**
 * Naming the calling application to a provider that reports on it.
 *
 * Same split as the session id: the consumer owns the identity (nax decides it
 * is called "nax", and where it lives), and this package owns which vendor
 * spells that in which header. OpenRouter is the one that documents a pair —
 * `HTTP-Referer` for the app's URL, `X-Title` for its display name — and reads
 * them into the `app_id`, `origin` and `http_referer` fields of every
 * generation record. Nothing in pi-ai touches either header at any version, so
 * without this every request from every pi-ai consumer is indistinguishable on
 * a provider's dashboard: the only identifying header on the wire is pi-ai's
 * own `User-Agent`, which reads "pi (<platform> <release>; <arch>)" for all of
 * them.
 */
import type { AssistantMessageEvent, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { vendorAppHeaders } from "../../src/protocols/client-app.ts";
import { createPiDeps } from "../../src/protocols/pi-client.ts";

async function* emptyStream(): AsyncGenerator<AssistantMessageEvent> {}

describe("vendorAppHeaders", () => {
  it("spells both fields for openrouter, which reports on them per generation", () => {
    expect(vendorAppHeaders("openrouter", { name: "nax", url: "https://example.invalid/nax" })).toEqual({
      "HTTP-Referer": "https://example.invalid/nax",
      "X-Title": "nax",
    });
  });

  it("sends only the field the caller supplied", () => {
    expect(vendorAppHeaders("openrouter", { name: "nax" })).toEqual({ "X-Title": "nax" });
    expect(vendorAppHeaders("openrouter", { url: "https://example.invalid/nax" })).toEqual({
      "HTTP-Referer": "https://example.invalid/nax",
    });
  });

  it.each(["openai", "anthropic", "deepseek", "opencode-go"])(
    "adds nothing for %s, which documents no such header",
    (provider) => {
      expect(vendorAppHeaders(provider, { name: "nax", url: "https://example.invalid/nax" })).toBeUndefined();
    },
  );

  it("adds nothing when the caller named no app", () => {
    expect(vendorAppHeaders("openrouter", undefined)).toBeUndefined();
  });

  it("treats empty strings as absent, so a blank value never reaches the wire", () => {
    expect(vendorAppHeaders("openrouter", { name: "", url: "" })).toBeUndefined();
  });

  it.each(["constructor", "__proto__", "toString"])("does not resolve %s off the prototype", (provider) => {
    // Same trap vendorSessionHeaders guards: indexing an object literal with
    // one of these names yields a function, and its body would become a header.
    expect(vendorAppHeaders(provider, { name: "nax" })).toBeUndefined();
  });
});

describe("createPiDeps app wiring", () => {
  async function headersFor(
    clientApp: { name?: string; url?: string } | undefined,
    provider: string,
    model: string,
    requestHeaders?: Readonly<Record<string, string>>,
  ): Promise<SimpleStreamOptions["headers"]> {
    let seen: SimpleStreamOptions | undefined;
    const deps = createPiDeps({ ...(clientApp !== undefined ? { clientApp } : {}) }, (_m, _c, options) => {
      seen = options;
      return emptyStream();
    });
    const resolved = await deps.resolveModel(model, provider);
    for await (const _ of deps.stream(
      resolved,
      { messages: [] },
      { ...(requestHeaders !== undefined ? { headers: requestHeaders } : {}) },
      () => {},
    )) {
      // drain
    }
    return seen?.headers;
  }

  it("puts both headers on an openrouter request", async () => {
    const headers = await headersFor({ name: "nax", url: "https://example.invalid/nax" }, "openrouter", "z-ai/glm-5.3");
    expect(headers).toMatchObject({ "HTTP-Referer": "https://example.invalid/nax", "X-Title": "nax" });
  });

  it("leaves a provider that documents no such header alone", async () => {
    const headers = await headersFor({ name: "nax", url: "https://example.invalid/nax" }, "openai-codex", "gpt-5.4");
    expect(headers?.["X-Title"]).toBeUndefined();
    expect(headers?.["HTTP-Referer"]).toBeUndefined();
  });

  it("sends nothing extra when no app was named", async () => {
    const headers = await headersFor(undefined, "openrouter", "z-ai/glm-5.3");
    expect(headers?.["X-Title"]).toBeUndefined();
    expect(headers?.["HTTP-Referer"]).toBeUndefined();
  });

  it("lets an explicit request header override the vendor spelling", async () => {
    const headers = await headersFor({ name: "nax" }, "openrouter", "z-ai/glm-5.3", { "X-Title": "explicit" });
    expect(headers?.["X-Title"]).toBe("explicit");
  });

  it("rejects a spliceable app name where the header reaches the wire", async () => {
    await expect(headersFor({ name: "nax\r\nx-injected: 1" }, "openrouter", "z-ai/glm-5.3")).rejects.toThrow();
  });
});
