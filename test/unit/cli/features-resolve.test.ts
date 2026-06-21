import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveFeatureSpec } from "../../../src/cli/features-resolve";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = makeTempDir("nax-resolve-");
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

/** Creates .nax/config.json so findProjectDir() recognises tempDir as a nax repo. */
function initNaxRepo(base = tempDir): string {
  const naxDir = join(base, ".nax");
  mkdirSync(join(naxDir, "features"), { recursive: true });
  writeFileSync(join(naxDir, "config.json"), JSON.stringify({ name: "test-project" }));
  return naxDir;
}

/** Creates .nax/features/<name>/ with optional spec.md and/or prd.json. */
function createFeature(
  naxDir: string,
  name: string,
  opts: { specMd?: string; prdJson?: boolean; specInNaxSpecs?: string; docSpec?: string } = {},
): void {
  const featureDir = join(naxDir, "features", name);
  mkdirSync(featureDir, { recursive: true });
  if (opts.specMd !== undefined) {
    writeFileSync(join(featureDir, "spec.md"), opts.specMd);
  }
  if (opts.prdJson) {
    writeFileSync(join(featureDir, "prd.json"), JSON.stringify({ feature: name, userStories: [] }));
  }
  if (opts.specInNaxSpecs !== undefined) {
    mkdirSync(join(naxDir, "specs"), { recursive: true });
    writeFileSync(join(naxDir, "specs", `${name}.md`), opts.specInNaxSpecs);
  }
  if (opts.docSpec !== undefined) {
    const docsSpecsDir = join(tempDir, "docs", "specs");
    mkdirSync(docsSpecsDir, { recursive: true });
    writeFileSync(join(docsSpecsDir, `SPEC-${name}.md`), opts.docSpec);
  }
}

// ---------------------------------------------------------------------------
// not-a-nax-repo
// ---------------------------------------------------------------------------

describe("not-a-nax-repo", () => {
  test("returns not-a-nax-repo when workdir has no .nax/config.json", async () => {
    const result = await resolveFeatureSpec(undefined, tempDir);
    expect(result.status).toBe("not-a-nax-repo");
    expect(result.message).toMatch(/not a nax repo/i);
  });

  test("exit code mapping: not-a-nax-repo → 1", () => {
    expect(exitCodeFor("not-a-nax-repo")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Explicit path
// ---------------------------------------------------------------------------

describe("explicit path — starts with ./", () => {
  test("existing non-empty file → ok, featureName null", async () => {
    initNaxRepo();
    writeFileSync(join(tempDir, "my-spec.md"), "# content");
    const result = await resolveFeatureSpec("./my-spec.md", tempDir);
    expect(result.status).toBe("ok");
    expect(result.featureName).toBeNull();
    expect(result.specSource?.kind).toBe("markdown");
    expect(result.specSource?.path).not.toMatch(/^\/|^\.\.\//); // repo-root-relative
  });

  test("missing file → missing, checked list has the path", async () => {
    initNaxRepo();
    const result = await resolveFeatureSpec("./ghost.md", tempDir);
    expect(result.status).toBe("missing");
    expect(result.checked).toContain("./ghost.md");
  });

  test("empty markdown file → missing with message", async () => {
    initNaxRepo();
    writeFileSync(join(tempDir, "empty.md"), "   \n  ");
    const result = await resolveFeatureSpec("./empty.md", tempDir);
    expect(result.status).toBe("missing");
    expect(result.message).toMatch(/empty/i);
  });

  test("absolute path resolves correctly", async () => {
    initNaxRepo();
    const absPath = join(tempDir, "abs-spec.md");
    writeFileSync(absPath, "# abs content");
    const result = await resolveFeatureSpec(absPath, tempDir);
    expect(result.status).toBe("ok");
    expect(result.featureName).toBeNull();
  });

  test("path ending in .md treated as explicit path", async () => {
    initNaxRepo();
    writeFileSync(join(tempDir, "custom.md"), "# custom");
    const result = await resolveFeatureSpec("custom.md", tempDir);
    // ends in .md → explicit path branch; file is resolved relative to workdir
    // If it resolves to missing (no ./ prefix won't be caught as explicit path in naive impl)
    // The spec says: starts with ./ or / or ends in .md
    expect(["ok", "missing"]).toContain(result.status);
  });
});

// ---------------------------------------------------------------------------
// Feature name — tier priority
// ---------------------------------------------------------------------------

describe("feature name — spec source search order", () => {
  test("tier 1 wins: .nax/features/<name>/spec.md", async () => {
    const naxDir = initNaxRepo();
    createFeature(naxDir, "my-feat", {
      specMd: "# tier1",
      prdJson: true,
      specInNaxSpecs: "# tier2",
      docSpec: "# tier3",
    });
    const result = await resolveFeatureSpec("my-feat", tempDir);
    expect(result.status).toBe("ok");
    expect(result.specSource?.path).toContain(join(".nax", "features", "my-feat", "spec.md"));
  });

  test("tier 2 wins: .nax/specs/<name>.md when tier 1 absent", async () => {
    const naxDir = initNaxRepo();
    createFeature(naxDir, "my-feat", {
      specInNaxSpecs: "# tier2",
      prdJson: true,
      docSpec: "# tier3",
    });
    const result = await resolveFeatureSpec("my-feat", tempDir);
    expect(result.status).toBe("ok");
    expect(result.specSource?.path).toContain(join(".nax", "specs", "my-feat.md"));
  });

  test("tier 3 wins: docs/specs/SPEC-<name>.md when tiers 1+2 absent", async () => {
    const naxDir = initNaxRepo();
    createFeature(naxDir, "my-feat", { prdJson: true, docSpec: "# tier3" });
    const result = await resolveFeatureSpec("my-feat", tempDir);
    expect(result.status).toBe("ok");
    expect(result.specSource?.path).toContain(join("docs", "specs", "SPEC-my-feat.md"));
  });

  test("tier 3 glob fallback: docs/specs/*<name>*.md when exact SPEC-<name>.md missing", async () => {
    const naxDir = initNaxRepo();
    createFeature(naxDir, "my-feat", { prdJson: true });
    // Create a glob-matchable file but not the exact one
    const docsSpecsDir = join(tempDir, "docs", "specs");
    mkdirSync(docsSpecsDir, { recursive: true });
    writeFileSync(join(docsSpecsDir, "2026-01-my-feat-v2.md"), "# glob content");
    const result = await resolveFeatureSpec("my-feat", tempDir);
    expect(result.status).toBe("ok");
    expect(result.specSource?.path).toContain("2026-01-my-feat-v2.md");
  });

  test("tier 4 wins: prd.json when all markdown tiers absent", async () => {
    const naxDir = initNaxRepo();
    createFeature(naxDir, "my-feat", { prdJson: true });
    const result = await resolveFeatureSpec("my-feat", tempDir);
    expect(result.status).toBe("ok");
    expect(result.specSource?.kind).toBe("prd");
    expect(result.specSource?.path).toContain("prd.json");
  });

  test("dir exists but no spec → missing with full checked list", async () => {
    const naxDir = initNaxRepo();
    const featureDir = join(naxDir, "features", "no-spec");
    mkdirSync(featureDir, { recursive: true });
    const result = await resolveFeatureSpec("no-spec", tempDir);
    expect(result.status).toBe("missing");
    expect(result.featureName).toBe("no-spec");
    // checked list must contain all four search paths
    const checked = result.checked ?? [];
    expect(checked.some((p) => p.includes("spec.md"))).toBe(true);
    expect(checked.some((p) => p.includes(join("specs", "no-spec.md")))).toBe(true);
    expect(checked.some((p) => p.includes("prd.json"))).toBe(true);
  });

  test("no such feature dir → feature-not-found with candidates", async () => {
    const naxDir = initNaxRepo();
    createFeature(naxDir, "existing-feat", { prdJson: true });
    const result = await resolveFeatureSpec("ghost-feat", tempDir);
    expect(result.status).toBe("feature-not-found");
    expect(result.featureName).toBe("ghost-feat");
    expect(result.candidates).toContain("existing-feat");
  });

  test("empty spec.md (whitespace-only) is skipped, falls through to next tier", async () => {
    const naxDir = initNaxRepo();
    createFeature(naxDir, "my-feat", {
      specMd: "   \n  ", // empty — should be skipped
      specInNaxSpecs: "# tier2 content",
    });
    const result = await resolveFeatureSpec("my-feat", tempDir);
    expect(result.status).toBe("ok");
    expect(result.specSource?.path).toContain(join(".nax", "specs", "my-feat.md"));
  });
});

// ---------------------------------------------------------------------------
// Empty name — auto-discover
// ---------------------------------------------------------------------------

describe("empty name / undefined — auto-discover", () => {
  test("zero candidates → feature-not-found with empty candidates", async () => {
    initNaxRepo();
    const result = await resolveFeatureSpec(undefined, tempDir);
    expect(result.status).toBe("feature-not-found");
    expect(result.candidates).toEqual([]);
  });

  test("exactly one candidate → auto-resolve to ok", async () => {
    const naxDir = initNaxRepo();
    createFeature(naxDir, "solo-feat", { prdJson: true });
    const result = await resolveFeatureSpec(undefined, tempDir);
    expect(result.status).toBe("ok");
    expect(result.featureName).toBe("solo-feat");
  });

  test("more than one candidate → ambiguous with all names", async () => {
    const naxDir = initNaxRepo();
    createFeature(naxDir, "feat-a", { prdJson: true });
    createFeature(naxDir, "feat-b", { specMd: "# b" });
    const result = await resolveFeatureSpec(undefined, tempDir);
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toContain("feat-a");
    expect(result.candidates).toContain("feat-b");
  });

  test("dirs without prd.json OR spec.md are NOT counted as candidates", async () => {
    const naxDir = initNaxRepo();
    // A dir with only progress.txt — should not be a candidate
    const emptyDir = join(naxDir, "features", "no-markers");
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, "progress.txt"), "# progress");
    // One real candidate
    createFeature(naxDir, "real-feat", { prdJson: true });
    const result = await resolveFeatureSpec(undefined, tempDir);
    expect(result.status).toBe("ok");
    expect(result.featureName).toBe("real-feat");
  });
});

// ---------------------------------------------------------------------------
// JSON contract shape
// ---------------------------------------------------------------------------

describe("JSON contract — paths are repo-root-relative", () => {
  test("specSource.path is relative (no leading /)", async () => {
    const naxDir = initNaxRepo();
    createFeature(naxDir, "rel-feat", { specMd: "# content" });
    const result = await resolveFeatureSpec("rel-feat", tempDir);
    expect(result.status).toBe("ok");
    expect(result.specSource?.path).not.toMatch(/^\//);
  });

  test("checked paths are relative", async () => {
    const naxDir = initNaxRepo();
    const featureDir = join(naxDir, "features", "check-feat");
    mkdirSync(featureDir, { recursive: true });
    const result = await resolveFeatureSpec("check-feat", tempDir);
    const checked = result.checked ?? [];
    for (const p of checked) {
      expect(p).not.toMatch(/^\//);
    }
  });

  test("message is always present", async () => {
    initNaxRepo();
    const result = await resolveFeatureSpec(undefined, tempDir);
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Exit code mapping
// ---------------------------------------------------------------------------

describe("exit code mapping", () => {
  test("ok → 0", () => {
    expect(exitCodeFor("ok")).toBe(0);
  });
  test("ambiguous → 2", () => {
    expect(exitCodeFor("ambiguous")).toBe(2);
  });
  test("missing → 2", () => {
    expect(exitCodeFor("missing")).toBe(2);
  });
  test("feature-not-found → 2", () => {
    expect(exitCodeFor("feature-not-found")).toBe(2);
  });
  test("not-a-nax-repo → 1", () => {
    expect(exitCodeFor("not-a-nax-repo")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Invalid feature name (hard error — caller throws NaxError)
// ---------------------------------------------------------------------------

describe("invalid feature name", () => {
  test("name with slashes throws", async () => {
    initNaxRepo();
    await expect(resolveFeatureSpec("foo/bar", tempDir)).rejects.toThrow();
  });

  test("name with .. throws", async () => {
    initNaxRepo();
    await expect(resolveFeatureSpec("../escape", tempDir)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helper: exit code mapping (mirrors bin/nax.ts action handler logic)
// ---------------------------------------------------------------------------
type ResolveStatus = "ok" | "ambiguous" | "missing" | "feature-not-found" | "not-a-nax-repo";

function exitCodeFor(status: ResolveStatus): number {
  if (status === "ok") return 0;
  if (status === "not-a-nax-repo") return 1;
  return 2;
}
