import { describe, expect, test } from "bun:test";
import { createWebExposure as createWebExposureFromInternal } from "@nathapp/nax-agent/internal";
import { createWebExposure } from "#src/web/exposure";
import { WEB_SEEN_URL_CAP } from "#src/web/types";

/** `count` distinct, valid URLs in recording order, so eviction order is checkable. */
function distinctUrls(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `https://a.example/${index}`);
}

const RESTORED = {
  exposedAt: "2026-11-26T10:00:00.000Z",
  seenUrls: ["https://a.example/"],
  searches: 2,
};

describe("createWebExposure", () => {
  describe("initial state", () => {
    test("starts with no exposure time, no seen URLs and no searches", () => {
      expect(createWebExposure().snapshot()).toEqual({ exposedAt: null, seenUrls: [], searches: 0 });
    });

    test("is not exposed before a web result", () => {
      expect(createWebExposure().isExposed()).toBe(false);
    });
  });

  describe("exposure marker", () => {
    test("records the ISO time of the first markExposed", () => {
      const exposure = createWebExposure();
      exposure.markExposed(new Date("2026-11-26T10:00:00.000Z"));
      expect(exposure.snapshot().exposedAt).toBe("2026-11-26T10:00:00.000Z");
    });

    test("is exposed once marked", () => {
      const exposure = createWebExposure();
      exposure.markExposed(new Date("2026-11-26T10:00:00.000Z"));
      expect(exposure.isExposed()).toBe(true);
    });

    test("keeps the first exposure time when marked again with a later one", () => {
      const exposure = createWebExposure();
      exposure.markExposed(new Date("2026-11-26T10:00:00.000Z"));
      exposure.markExposed(new Date("2026-11-26T11:30:00.000Z"));
      expect(exposure.snapshot().exposedAt).toBe("2026-11-26T10:00:00.000Z");
    });
  });

  describe("seen URLs", () => {
    test("matches a recorded URL once it is normalised, in whatever spelling it was recorded", () => {
      const exposure = createWebExposure();
      exposure.recordUrls(["HTTPS://A.example/x#f"]);
      expect(exposure.hasSeen("https://a.example/x")).toBe(true);
    });

    test("normalises, drops a non-http URL and dedupes within one call", () => {
      const exposure = createWebExposure();
      exposure.recordUrls(["https://a.example/x", "mailto:x@y", "https://a.example/x"]);
      expect(exposure.snapshot().seenUrls).toEqual(["https://a.example/x"]);
    });

    test("keeps at most WEB_SEEN_URL_CAP URLs once more than that are recorded", () => {
      const exposure = createWebExposure();
      exposure.recordUrls(distinctUrls(WEB_SEEN_URL_CAP + 1));
      expect(exposure.snapshot().seenUrls.length).toBe(WEB_SEEN_URL_CAP);
    });

    test("drops the oldest URL past the cap so it is no longer seen", () => {
      const urls = distinctUrls(WEB_SEEN_URL_CAP + 1);
      const oldest = urls[0] ?? "";
      const newest = urls[urls.length - 1] ?? "";
      const exposure = createWebExposure();
      exposure.recordUrls(urls);
      expect(exposure.hasSeen(oldest)).toBe(false);
      expect(exposure.hasSeen(newest)).toBe(true);
    });

    test("leaves the snapshot untouched when no input is a URL", () => {
      const exposure = createWebExposure();
      exposure.recordUrls(["mailto:x@y", "not a url"]);
      expect(exposure.snapshot()).toEqual({ exposedAt: null, seenUrls: [], searches: 0 });
    });

    test("reports a URL it never saw, and unparseable input, as not seen", () => {
      const exposure = createWebExposure();
      exposure.recordUrls(["https://a.example/"]);
      expect(exposure.hasSeen("https://b.example/")).toBe(false);
      expect(exposure.hasSeen("not a url")).toBe(false);
    });

    test("keeps only the newest WEB_SEEN_URL_CAP URLs of an over-cap restored snapshot", () => {
      const urls = distinctUrls(WEB_SEEN_URL_CAP + 1);
      const exposure = createWebExposure({ exposedAt: null, seenUrls: urls, searches: 0 });
      expect(exposure.snapshot().seenUrls).toEqual(urls.slice(1));
    });
  });

  describe("restoration", () => {
    test("restores the stored snapshot unchanged", () => {
      expect(createWebExposure(RESTORED).snapshot()).toEqual(RESTORED);
    });

    test("is exposed when the restored snapshot carries an exposure time", () => {
      expect(createWebExposure(RESTORED).isExposed()).toBe(true);
    });
  });

  describe("search count", () => {
    test("counts every successful search", () => {
      const exposure = createWebExposure();
      exposure.countSearch();
      exposure.countSearch();
      expect(exposure.snapshot().searches).toBe(2);
    });
  });

  describe("change listeners", () => {
    test("calls the listener with the new snapshot after markExposed", () => {
      const exposure = createWebExposure();
      const seen: unknown[] = [];
      exposure.onChange((snapshot) => {
        seen.push(snapshot);
      });
      exposure.markExposed(new Date("2026-11-26T10:00:00.000Z"));
      expect(seen).toEqual([exposure.snapshot()]);
    });

    test("calls the listener after recordUrls adds a new URL", () => {
      const exposure = createWebExposure();
      const seen: unknown[] = [];
      exposure.onChange((snapshot) => {
        seen.push(snapshot);
      });
      exposure.recordUrls(["https://a.example/"]);
      expect(seen).toEqual([{ exposedAt: null, seenUrls: ["https://a.example/"], searches: 0 }]);
    });

    test("does not call the listener when recordUrls adds nothing new", () => {
      const exposure = createWebExposure();
      exposure.recordUrls(["https://a.example/"]);
      let calls = 0;
      exposure.onChange(() => {
        calls += 1;
      });
      exposure.recordUrls(["https://a.example/", "mailto:x@y"]);
      expect(calls).toBe(0);
    });

    test("does not call the listener for a second markExposed", () => {
      const exposure = createWebExposure();
      exposure.markExposed(new Date("2026-11-26T10:00:00.000Z"));
      let calls = 0;
      exposure.onChange(() => {
        calls += 1;
      });
      exposure.markExposed(new Date("2026-11-26T11:30:00.000Z"));
      expect(calls).toBe(0);
    });

    test("calls the listener after countSearch", () => {
      const exposure = createWebExposure();
      const seen: number[] = [];
      exposure.onChange((snapshot) => {
        seen.push(snapshot.searches);
      });
      exposure.countSearch();
      expect(seen).toEqual([1]);
    });

    test("stops calling the listener once its unsubscribe function is invoked", () => {
      const exposure = createWebExposure();
      let calls = 0;
      const unsubscribe = exposure.onChange(() => {
        calls += 1;
      });
      exposure.markExposed(new Date("2026-11-26T10:00:00.000Z"));
      unsubscribe();
      exposure.countSearch();
      expect(calls).toBe(1);
    });
  });

  describe("internal entry", () => {
    test("is reachable through @nathapp/nax-agent/internal", () => {
      expect(createWebExposureFromInternal().isExposed()).toBe(false);
    });
  });
});
