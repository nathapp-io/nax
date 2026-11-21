import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const REPO = new URL("../../../../../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, REPO), "utf8");
}

interface WorkflowStep {
  uses?: string;
}

interface CiWorkflow {
  on: { push: { paths: string[] }; pull_request: { paths: string[] } };
}

interface ReleaseWorkflow {
  jobs: Record<string, { steps: WorkflowStep[] }>;
}

const ci = Bun.YAML.parse(read(".github/workflows/ci.yml")) as CiWorkflow;
const release = Bun.YAML.parse(read(".github/workflows/release.yml")) as ReleaseWorkflow;
const rootPackage = JSON.parse(read("package.json")) as { patchedDependencies?: Record<string, string> };

const PUSH = ci.on.push.paths;
const PULL_REQUEST = ci.on.pull_request.paths;

/** Every local action release.yml uses, as the root-relative path of its action.yml. */
const releaseActions = [
  ...new Set(
    Object.values(release.jobs)
      .flatMap((job) => job.steps.map((step) => step.uses))
      .filter((uses): uses is string => typeof uses === "string" && uses.startsWith("./")),
  ),
].map((uses) => `${uses.slice(2).replace(/\/$/, "")}/action.yml`);

const patchFiles = Object.values(rootPackage.patchedDependencies ?? {});

/** The files no glob in `globs` matches, matched against GitHub's own path-filter syntax. */
function unmatched(globs: readonly string[], files: readonly string[]): string[] {
  return files.filter((file) => !globs.some((glob) => new Bun.Glob(glob).match(file)));
}

describe("CI path filters cover the release inputs", () => {
  test("release.yml uses local actions, so the check below is not vacuous", () => {
    expect(releaseActions.length).toBeGreaterThan(0);
  });

  test("on.push.paths covers every local action release.yml uses", () => {
    expect(unmatched(PUSH, releaseActions)).toEqual([]);
  });

  test("on.pull_request.paths covers every local action release.yml uses", () => {
    expect(unmatched(PULL_REQUEST, releaseActions)).toEqual([]);
  });

  test("both path lists cover every patched dependency the root package.json applies", () => {
    expect(patchFiles.length).toBeGreaterThan(0);
    expect(unmatched(PUSH, patchFiles)).toEqual([]);
    expect(unmatched(PULL_REQUEST, patchFiles)).toEqual([]);
  });

  test.each([".github/workflows/release.yml", "package.json"])("%s is inside both path lists", (file) => {
    expect(unmatched(PUSH, [file])).toEqual([]);
    expect(unmatched(PULL_REQUEST, [file])).toEqual([]);
  });
});
