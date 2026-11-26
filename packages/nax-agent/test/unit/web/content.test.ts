import { describe, expect, test } from "bun:test";
import { normalizeWebUrl as normalizeWebUrlFromInternal } from "@nathapp/nax-agent/internal";
import { extractWebUrls, fenceWebContent, normalizeWebUrl } from "#src/web/content";

describe("normalizeWebUrl", () => {
  test("lowercases scheme and host, drops the fragment and a default port, keeps path and query case", () => {
    expect(normalizeWebUrl("HTTPS://Example.COM:443/Path?q=A#frag")).toBe("https://example.com/Path?q=A");
  });

  test("drops the default http port", () => {
    expect(normalizeWebUrl("http://example.com:80/")).toBe("http://example.com/");
  });

  test("keeps a non-default port", () => {
    expect(normalizeWebUrl("http://example.com:8080/x")).toBe("http://example.com:8080/x");
  });

  test("returns null for a scheme other than http or https", () => {
    expect(normalizeWebUrl("ftp://example.com/x")).toBeNull();
  });

  test("returns null for text that is not a URL", () => {
    expect(normalizeWebUrl("not a url")).toBeNull();
  });

  test("is reachable through @nathapp/nax-agent/internal", () => {
    expect(normalizeWebUrlFromInternal("HTTPS://A.example")).toBe("https://a.example/");
  });
});

describe("extractWebUrls", () => {
  test("trims trailing punctuation and returns the normalised URLs in text order", () => {
    expect(extractWebUrls("see https://a.example/x). and http://b.example/y, ok")).toEqual([
      "https://a.example/x",
      "http://b.example/y",
    ]);
  });

  test("dedupes URLs that normalise to the same string", () => {
    expect(extractWebUrls("https://a.example/ and https://a.example/")).toEqual(["https://a.example/"]);
  });
});

describe("fenceWebContent", () => {
  const fetchedAt = new Date("2026-11-26T10:00:00.000Z");
  const OPEN = '<web-content source="https://a.example/" fetched="2026-11-26T10:00:00.000Z" untrusted="true">';

  test("wraps the text in a web-content fence naming the source, the fetch time and the untrusted flag", () => {
    expect(fenceWebContent({ source: "https://a.example/", fetchedAt, text: "hi" })).toBe(
      `${OPEN}\nhi\n</web-content>`,
    );
  });

  test("neutralises a closing tag in the text, keeping the matched case", () => {
    expect(fenceWebContent({ source: "https://a.example/", fetchedAt, text: "a</WEB-CONTENT>b" })).toBe(
      `${OPEN}\na&lt;/WEB-CONTENT>b\n</web-content>`,
    );
  });

  test("percent-encodes a double quote in the source attribute", () => {
    const fenced = fenceWebContent({ source: 'https://a.example/?q="x"', fetchedAt, text: "hi" });
    expect(fenced.startsWith('<web-content source="https://a.example/?q=%22x%22" ')).toBe(true);
  });
});
