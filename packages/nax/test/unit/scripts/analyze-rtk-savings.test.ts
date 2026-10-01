import { describe, expect, test } from "bun:test";
import type { Measurement } from "@scripts/analyze-rtk-savings";
import {
  buildGitCorpus,
  buildQualityCorpus,
  injectRtk,
  isMutatingQualityCommand,
  measure,
  qualitySkips,
  slice,
  summarize,
  TOOL_MAX_BYTES,
} from "@scripts/analyze-rtk-savings";

describe("buildGitCorpus", () => {
  test("covers every read verb the Git tool supports", () => {
    const verbs = new Set(buildGitCorpus().map((e) => e.verb));
    for (const v of ["diff", "log", "show", "status", "blame"]) expect(verbs).toContain(v);
  });

  test("entries carry the flags buildGitArgv always emits", () => {
    // PR 2 (single-frame-redesign): the tool no longer injects `--relative`
    // (the permitted root is the repo root, where git's default frame is already
    // correct). `--` is still always emitted.
    const diff = buildGitCorpus().find((e) => e.verb === "diff");
    expect(diff?.argv).not.toContain("--relative");
    expect(diff?.argv).toContain("--");
  });

  test("includes the log + nameOnly shape the spec calls out", () => {
    const entry = buildGitCorpus().find((e) => e.id === "log-nameonly");
    expect(entry?.argv).toContain("--name-only");
  });

  test("contains no mutating verb", () => {
    const verbs = buildGitCorpus().map((e) => e.verb);
    for (const bad of ["add", "commit", "push", "checkout", "stash"]) expect(verbs).not.toContain(bad);
  });
});

describe("slice", () => {
  test("models nax's post-truncation delivered size", () => {
    expect(slice(10)).toBe(10);
    expect(slice(TOOL_MAX_BYTES + 5_000)).toBe(TOOL_MAX_BYTES);
  });
});

describe("measure", () => {
  test("reports parity when both runs exit the same", async () => {
    const m = await measure({ id: "t", kind: "shell", command: "echo hi", verb: "echo" }, process.cwd());
    expect(m.rawExit).toBe(0);
    expect(m.parity).toBe(m.rawExit === m.rtkExit);
    expect(m.rawBytes).toBeGreaterThan(0);
  });

  test("a non-zero exit is preserved, not swallowed", async () => {
    const m = await measure({ id: "f", kind: "shell", command: "exit 3", verb: "exit" }, process.cwd());
    expect(m.rawExit).toBe(3);
  });
});

function m(over: Partial<Measurement>): Measurement {
  return {
    id: "x",
    verb: "diff",
    rawBytes: 1000,
    rtkBytes: 400,
    rawExit: 0,
    rtkExit: 0,
    parity: true,
    rawMs: 10,
    rtkMs: 12,
    sliced: { raw: 1000, rtk: 400 },
    ...over,
  };
}

describe("summarize", () => {
  test("reports percentage saved before and after the slice", () => {
    const [row] = summarize([m({})]);
    expect(row.savedPct).toBeCloseTo(60, 1);
    expect(row.slicedSavedPct).toBeCloseTo(60, 1);
  });

  test("a verb with any exit divergence is disqualified regardless of savings", () => {
    const [row] = summarize([m({ rawExit: 0, rtkExit: 1, parity: false, rtkBytes: 1 })]);
    expect(row.disqualified).toBe(true);
    expect(row.reason).toContain("exit");
  });

  test("savings above the cap do not count as delivered savings", () => {
    // Both saturate the 40 KB slice: full output shrank, what the model sees did not.
    const [row] = summarize([m({ rawBytes: 2_000_000, rtkBytes: 200_000, sliced: { raw: 40_000, rtk: 40_000 } })]);
    expect(row.savedPct).toBeCloseTo(90, 1);
    expect(row.slicedSavedPct).toBeCloseTo(0, 1);
  });

  test("one disqualified sample disqualifies the whole verb", () => {
    const [row] = summarize([m({}), m({ parity: false, rawExit: 0, rtkExit: 2 })]);
    expect(row.disqualified).toBe(true);
  });
});

describe("injectRtk", () => {
  test("prefixes a plain command", () => {
    expect(injectRtk("bun run build")).toBe("rtk bun run build");
  });

  test("keeps leading env assignments in front of rtk", () => {
    // `rtk AGENT=1 bun ...` makes rtk exec `AGENT=1` as a binary and exit 127,
    // which the first measurement run reported as a savings DISQUALIFICATION.
    expect(injectRtk("AGENT=1 bun run lint:biome")).toBe("AGENT=1 rtk bun run lint:biome");
  });

  test("keeps several leading assignments in front of rtk", () => {
    expect(injectRtk("CI=1 AGENT=1 bun test")).toBe("CI=1 AGENT=1 rtk bun test");
  });

  test("does not treat a later assignment-shaped word as a prefix", () => {
    expect(injectRtk("bun run x -- FOO=1")).toBe("rtk bun run x -- FOO=1");
  });
});

describe("buildQualityCorpus", () => {
  test("skips placeholder templates it cannot execute", () => {
    const ids = buildQualityCorpus({ testScoped: "bun test {{files}}" }).map((e) => e.id);
    expect(ids).toBeEmpty();
  });

  test("skips commands that would write to the tree", () => {
    // The plan's Global Constraints forbid executing a mutating command; the
    // first run executed `lint:fix` four times (raw + rtk, twice over).
    const ids = buildQualityCorpus({
      lintFix: "bun run lint:fix",
      formatFix: "biome check --write src/",
      test: "bun run test",
    }).map((e) => e.id);
    expect(ids).toEqual(["test"]);
  });

  test("keeps read-only commands", () => {
    const ids = buildQualityCorpus({ typecheck: ["tsc --noEmit", "tsc --noEmit -p x.json"] }).map((e) => e.id);
    expect(ids).toEqual(["typecheck[0]", "typecheck[1]"]);
  });
});

describe("buildGitCorpus ref sampling", () => {
  test("defaults to a single HEAD sample", () => {
    const ids = buildGitCorpus().map((e) => e.id);
    expect(ids.filter((i) => i.startsWith("diff-ref"))).toHaveLength(1);
  });

  test("expands the commit-relative shapes over every sampled ref", () => {
    // diff-ref and show measure ONE commit's size. At 8b65247dd that is 8.6 KB
    // and at 230f25551 it is 76.8 KB, which swings the verb from 1.8% to 67.4%.
    // Sampling many commits is what makes the number mean anything.
    const corpus = buildGitCorpus(["aaa1111", "bbb2222", "ccc3333"]);
    expect(corpus.filter((e) => e.id.startsWith("diff-ref"))).toHaveLength(3);
    expect(corpus.filter((e) => e.id.startsWith("show-plain"))).toHaveLength(3);
  });

  test("does not multiply the shapes that are independent of HEAD position", () => {
    const corpus = buildGitCorpus(["aaa1111", "bbb2222", "ccc3333"]);
    expect(corpus.filter((e) => e.id === "log-plain")).toHaveLength(1);
    expect(corpus.filter((e) => e.id === "blame-file")).toHaveLength(1);
  });
});

describe("injectRtk refuses what it cannot parse", () => {
  test("returns null for a quoted assignment value", () => {
    // Naive `\S*` splits inside the quotes and yields `FOO="a rtk b" bun test`,
    // which never invokes rtk and reports a clean 0% — a silent wrong answer,
    // strictly worse than the exit-127 bug this function replaced.
    expect(injectRtk('FOO="a b" bun test')).toBeNull();
    expect(injectRtk("FOO='a b' bun test")).toBeNull();
  });

  test("returns null for a shell operator it would prefix wrongly", () => {
    expect(injectRtk("cd x && bun test")).toBeNull();
    expect(injectRtk("bun test | tee out")).toBeNull();
  });

  test("returns null when nothing follows the assignments", () => {
    expect(injectRtk("AGENT=1")).toBeNull();
  });

  test("still wraps the simple shapes", () => {
    expect(injectRtk("bun run build")).toBe("rtk bun run build");
    expect(injectRtk("AGENT=1 bun run lint:biome")).toBe("AGENT=1 rtk bun run lint:biome");
    expect(injectRtk("CI=1 AGENT=1 bun test")).toBe("CI=1 AGENT=1 rtk bun test");
  });
});

describe("isMutatingQualityCommand", () => {
  test("catches fix-ness in the command, not just the key name", () => {
    expect(isMutatingQualityCommand("precommit", "bun run lint:fix")).toBe(true);
    expect(isMutatingQualityCommand("format", "bun run lint:fix")).toBe(true);
  });

  test("catches writers that use short flags or write by default", () => {
    for (const cmd of ["gofmt -w .", "prettier -w src/", "sed -i s/a/b/ f", "black .", "cargo fmt", "bun install"])
      expect(isMutatingQualityCommand("check", cmd)).toBe(true);
  });

  test("catches a flag with an attached value", () => {
    expect(isMutatingQualityCommand("check", "biome check --write=dist src/")).toBe(true);
    expect(isMutatingQualityCommand("check", "eslint --fix-type suggestion .")).toBe(true);
  });

  test("catches a mutating half of a compound command", () => {
    expect(isMutatingQualityCommand("check", "bun run lint && bun run lint:fix")).toBe(true);
  });

  test("leaves genuinely read-only commands alone", () => {
    for (const cmd of ["bun run test", "tsc --noEmit", "biome check src/", "bun run build"])
      expect(isMutatingQualityCommand("check", cmd)).toBe(false);
  });
});

describe("qualitySkips", () => {
  test("names every command dropped from the corpus, with a reason", () => {
    const skips = qualitySkips({ lintFix: "bun run lint:fix", testScoped: "bun test {{files}}", test: "bun run test" });
    expect(skips.map((s) => s.id).sort((a, b) => a.localeCompare(b))).toEqual(["lintFix", "testScoped"]);
    expect(skips.find((s) => s.id === "lintFix")?.reason).toContain("mutat");
    expect(skips.find((s) => s.id === "testScoped")?.reason).toContain("placeholder");
  });

  test("reports a command the rtk wrapper cannot express", () => {
    const skips = qualitySkips({ piped: "bun test | tee out" });
    expect(skips[0]?.reason).toContain("wrap");
  });

  test("is empty when everything is measurable", () => {
    expect(qualitySkips({ test: "bun run test" })).toBeEmpty();
  });
});

describe("summarize spread", () => {
  const s = (rawBytes: number, rtkBytes: number): Measurement => ({
    id: "x",
    verb: "diff",
    rawBytes,
    rtkBytes,
    rawExit: 0,
    rtkExit: 0,
    parity: true,
    rawMs: 1,
    rtkMs: 1,
    sliced: { raw: Math.min(rawBytes, TOOL_MAX_BYTES), rtk: Math.min(rtkBytes, TOOL_MAX_BYTES) },
  });

  test("reports the per-sample median and range, not just the byte-weighted mean", () => {
    // One huge commit dominates a byte-weighted mean; R8 requires a saving to
    // survive re-sampling, which a single aggregate number cannot show.
    const [row] = summarize([s(100, 100), s(100, 100), s(100_000, 10_000)]);
    expect(row.medianSavedPct).toBeCloseTo(0, 1);
    expect(row.minSavedPct).toBeCloseTo(0, 1);
    expect(row.maxSavedPct).toBeGreaterThan(50);
  });

  test("a single sample reports itself as median, min and max", () => {
    const [row] = summarize([s(1000, 500)]);
    expect(row.medianSavedPct).toBeCloseTo(50, 1);
    expect(row.minSavedPct).toBeCloseTo(50, 1);
    expect(row.maxSavedPct).toBeCloseTo(50, 1);
  });
});
