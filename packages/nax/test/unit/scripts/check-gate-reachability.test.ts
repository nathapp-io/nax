import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import {
  collectReachableScriptFiles,
  discoverCheckScripts,
  findUnreachableCheckScripts,
  findUnreachableCheckScriptsInRepo,
  parseCiEntryPoints,
} from "@scripts/check-gate-reachability";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

function writeScripts(root: string, names: string[]) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const name of names) {
    writeFileSync(join(root, "scripts", name), "// gate\n");
  }
}

describe("discoverCheckScripts", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("nax-gate-reach-");
  });
  afterEach(() => cleanupTempDir(root));

  test("finds check-*.ts and check-*.sh, ignoring other scripts", () => {
    writeScripts(root, ["check-file-sizes.ts", "check-process-cwd.sh", "release.ts", "analyze-coverage-gap.ts"]);

    expect(discoverCheckScripts(root).sort(byCodePoint)).toEqual(["check-file-sizes.ts", "check-process-cwd.sh"]);
  });

  test("returns an empty list when scripts/ has no check scripts", () => {
    writeScripts(root, ["release.ts"]);

    expect(discoverCheckScripts(root)).toEqual([]);
  });
});

describe("parseCiEntryPoints", () => {
  test("collects `bun run <script>` invocations from run: steps", () => {
    const ci = `
jobs:
  test:
    steps:
      - name: Coverage
        run: bun run test:coverage
`;
    expect(parseCiEntryPoints(ci).scriptNames).toContain("test:coverage");
  });

  test("expands a matrix check list into script names", () => {
    const ci = `
    strategy:
      matrix:
        check: [typecheck, lint, check:all]
    steps:
      - run: bun run \${{ matrix.check }}
`;
    const names = parseCiEntryPoints(ci).scriptNames;
    expect(names).toContain("lint");
    expect(names).toContain("check:all");
  });

  test("collects direct scripts/ file references from run: steps", () => {
    const ci = `
    steps:
      - run: bash scripts/check-process-cwd.sh
`;
    expect(parseCiEntryPoints(ci).scriptFiles).toContain("check-process-cwd.sh");
  });
});

describe("collectReachableScriptFiles", () => {
  test("resolves a check script referenced directly by an entry point", () => {
    const reachable = collectReachableScriptFiles({
      entryScriptNames: ["check:all"],
      entryScriptFiles: [],
      packageScripts: {
        "check:all": "bun run scripts/check-file-sizes.ts",
      },
    });

    expect([...reachable]).toEqual(["check-file-sizes.ts"]);
  });

  test("follows `bun run <name>` transitively through package scripts", () => {
    const reachable = collectReachableScriptFiles({
      entryScriptNames: ["check:all"],
      entryScriptFiles: [],
      packageScripts: {
        "check:all": "bun run lint && bun run check:cwd",
        lint: "biome check src/ && bun run check:file-sizes",
        "check:file-sizes": "bun run scripts/check-file-sizes.ts",
        "check:cwd": "bash scripts/check-process-cwd.sh",
      },
    });

    expect([...reachable].sort()).toEqual(["check-file-sizes.ts", "check-process-cwd.sh"]);
  });

  test("terminates on a self-referential script instead of recursing forever", () => {
    const reachable = collectReachableScriptFiles({
      entryScriptNames: ["check:all"],
      entryScriptFiles: [],
      packageScripts: {
        "check:all": "bun run check:all && bun run scripts/check-file-sizes.ts",
      },
    });

    expect([...reachable]).toEqual(["check-file-sizes.ts"]);
  });

  test("counts a file reached only from CI, with no package script at all", () => {
    const reachable = collectReachableScriptFiles({
      entryScriptNames: [],
      entryScriptFiles: ["check-runtime-cleanup.sh"],
      packageScripts: {},
    });

    expect([...reachable]).toEqual(["check-runtime-cleanup.sh"]);
  });
});

describe("findUnreachableCheckScripts", () => {
  test("reports a check script that no entry point reaches", () => {
    const unreachable = findUnreachableCheckScripts({
      checkScripts: ["check-file-sizes.ts", "check-runtime-cleanup.sh"],
      entryScriptNames: ["check:all"],
      entryScriptFiles: [],
      packageScripts: {
        "check:all": "bun run scripts/check-file-sizes.ts",
      },
    });

    expect(unreachable).toEqual(["check-runtime-cleanup.sh"]);
  });

  test("reports nothing when every check script is reached", () => {
    const unreachable = findUnreachableCheckScripts({
      checkScripts: ["check-file-sizes.ts"],
      entryScriptNames: ["check:all"],
      entryScriptFiles: [],
      packageScripts: {
        "check:all": "bun run scripts/check-file-sizes.ts",
      },
    });

    expect(unreachable).toEqual([]);
  });
});

describe("findUnreachableCheckScriptsInRepo — package root vs repo root", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) cleanupTempDir(dir);
    dir = undefined;
  });

  test("reads package.json + scripts/ from the package and ci.yml from the repo root", async () => {
    const { findUnreachableCheckScriptsInRepo } = await import("@scripts/check-gate-reachability");
    dir = makeTempDir("nax-gate-two-roots-");
    const pkg = join(dir, "packages", "nax");
    mkdirSync(join(pkg, "scripts"), { recursive: true });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(pkg, "scripts", "check-a.ts"), "");
    writeFileSync(join(pkg, "scripts", "check-b.ts"), "");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ scripts: { "check:a": "bun run scripts/check-a.ts" } }));
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "      - run: bun run check:a\n");

    expect(findUnreachableCheckScriptsInRepo(pkg, dir)).toEqual(["check-b.ts"]);
  });
});

describe("findUnreachableCheckScriptsInRepo across workspace packages", () => {
  let repo = "";
  afterEach(() => {
    if (repo) cleanupTempDir(repo);
    repo = "";
  });

  function file(rel: string, content: string): void {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }

  function seed(naxAiScripts: Record<string, string>): void {
    repo = makeTempDir("gate-reach-ws-");
    file(".github/workflows/ci.yml", "jobs:\n  a:\n    steps:\n      - run: bun run check:all\n");
    file(
      "packages/nax/package.json",
      JSON.stringify({ scripts: { "check:all": "bun scripts/check-a.ts && bun ../repo-tooling/scripts/check-b.ts" } }),
    );
    file("packages/nax/scripts/check-a.ts", "");
    file("packages/repo-tooling/package.json", JSON.stringify({ scripts: { "check:all": "bun run lint" } }));
    file("packages/repo-tooling/scripts/check-b.ts", "");
    file("packages/repo-tooling/scripts/check-c.ts", "");
    file("packages/nax-ai/package.json", JSON.stringify({ scripts: naxAiScripts }));
  }

  test("a repo-tooling gate reached only from another package counts as reached", () => {
    seed({ "check:all": "bun ../repo-tooling/scripts/check-c.ts --package=." });
    expect(findUnreachableCheckScriptsInRepo(join(repo, "packages", "nax"), repo)).toEqual([]);
  });

  test("a repo-tooling gate no package runs is reported", () => {
    seed({ "check:all": "bun run lint" });
    expect(findUnreachableCheckScriptsInRepo(join(repo, "packages", "nax"), repo)).toEqual(["check-c.ts"]);
  });
});

describe("the nax repo itself", () => {
  test("every scripts/check-* gate is reachable from CI", async () => {
    const { findUnreachableCheckScriptsInRepo } = await import("@scripts/check-gate-reachability");
    const { findRepoRoot } = await import("@scripts/lib/repo-root");
    const packageRoot = join(import.meta.dir, "..", "..", "..");

    expect(findUnreachableCheckScriptsInRepo(packageRoot, findRepoRoot(packageRoot))).toEqual([]);
  });
});
