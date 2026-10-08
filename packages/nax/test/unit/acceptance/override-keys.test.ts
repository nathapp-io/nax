import { describe, expect, test } from "bun:test";
import { createOverrideLookup, scopedOverrideKey } from "@/acceptance/override-keys";

const WORKDIR = "/repo";
const API = "/repo/apps/api";
const WEB = "/repo/apps/web";

function lookup(
  overrides: Record<string, string>,
  counts: Array<[string, number]>,
  multiPackage = counts.length > 1,
): { reasonFor: (dir: string, ac: string) => string | undefined; ignored: string[] } {
  const ignored: string[] = [];
  const l = createOverrideLookup({
    overrides,
    workdir: WORKDIR,
    acCountByPackageDir: new Map(counts),
    multiPackage,
    onIgnoredBareKey: (acId) => ignored.push(acId),
  });
  return { reasonFor: (dir, ac) => l.reasonFor(dir, ac), ignored };
}

describe("scopedOverrideKey", () => {
  test("names the package relative to the repo root", () => {
    expect(scopedOverrideKey(WORKDIR, API, "AC-2")).toBe("apps/api::AC-2");
  });

  test("names the root package '.'", () => {
    expect(scopedOverrideKey(WORKDIR, WORKDIR, "AC-2")).toBe(".::AC-2");
  });
});

describe("createOverrideLookup", () => {
  test("a scoped key waives only its own package's criterion", () => {
    const { reasonFor } = lookup({ "apps/api::AC-2": "waived" }, [
      [API, 3],
      [WEB, 3],
    ]);
    expect(reasonFor(API, "AC-2")).toBe("waived");
    expect(reasonFor(WEB, "AC-2")).toBeUndefined();
  });

  test("a bare key is honoured in a single-package run", () => {
    expect(lookup({ "AC-2": "waived" }, [[WORKDIR, 3]]).reasonFor(WORKDIR, "AC-2")).toBe("waived");
  });

  test("a bare key is honoured in the single-file fallback even when stories span packages", () => {
    const { reasonFor } = lookup(
      { "AC-2": "waived" },
      [
        [API, 3],
        [WEB, 3],
      ],
      false,
    );
    expect(reasonFor(WORKDIR, "AC-2")).toBe("waived");
  });

  test("a bare key is honoured when exactly one package defines that AC number", () => {
    const { reasonFor, ignored } = lookup({ "AC-3": "waived" }, [
      [API, 3],
      [WEB, 2],
    ]);
    expect(reasonFor(API, "AC-3")).toBe("waived");
    expect(ignored).toEqual([]);
  });

  test("an ambiguous bare key is ignored everywhere and reported once", () => {
    const { reasonFor, ignored } = lookup({ "AC-2": "waived" }, [
      [API, 3],
      [WEB, 3],
    ]);
    expect(reasonFor(API, "AC-2")).toBeUndefined();
    expect(reasonFor(WEB, "AC-2")).toBeUndefined();
    expect(reasonFor(API, "AC-2")).toBeUndefined();
    expect(ignored).toEqual(["AC-2"]);
  });

  test("a scoped key wins over a bare key", () => {
    const { reasonFor } = lookup({ "AC-1": "bare", "apps/api::AC-1": "scoped" }, [[API, 1]]);
    expect(reasonFor(API, "AC-1")).toBe("scoped");
  });

  test("a sentinel is never waived by a bare key in a multi-package run", () => {
    const { reasonFor } = lookup({ "AC-HOOK": "waived" }, [
      [API, 3],
      [WEB, 3],
    ]);
    expect(reasonFor(API, "AC-HOOK")).toBeUndefined();
  });

  test("no overrides at all is never an override", () => {
    const l = createOverrideLookup({
      overrides: undefined,
      workdir: WORKDIR,
      acCountByPackageDir: new Map(),
      multiPackage: false,
      onIgnoredBareKey: () => {},
    });
    expect(l.reasonFor(WORKDIR, "AC-1")).toBeUndefined();
  });
});
