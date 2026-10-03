import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir } from "#test/helpers/index";
import { makeReleaseCliFixture } from "#test/helpers/release-cli-fixture";
import { makeReleaseShell, releaseStep, releaseWorkflow } from "#test/helpers/release-shell";

describe("release workflow routing", () => {
  test.each([
    ["nax-agent-v0.1.0", "packages/nax-agent", "@nathapp/nax-agent", "0.1.0"],
    ["nax-agent-v0.1.1-canary.1", "packages/nax-agent", "@nathapp/nax-agent", "0.1.1-canary.1"],
    ["nax-ai-v0.1.16", "packages/nax-ai", "@nathapp/nax-ai", "0.1.16"],
    ["v0.83.2", "packages/nax", "@nathapp/nax", "0.83.2"],
  ])("routes %s", (tag, dir, name, version) => {
    const shell = makeReleaseShell();
    try {
      const result = shell.run("Resolve package", { TAG: tag });
      expect(result.status).toBe(0);
      expect(result.values).toBe(`dir=${dir}\nname=${name}\nversion=${version}\n`);
    } finally {
      cleanupTempDir(shell.dir);
    }
  });

  test.each(["other-v0.1.0", "nax-agent-v", "nax-agent-v0.1.0;echo bad"])("rejects invalid tag %s", (tag) => {
    const shell = makeReleaseShell();
    try {
      expect(shell.run("Resolve package", { TAG: tag }).status).not.toBe(0);
    } finally {
      cleanupTempDir(shell.dir);
    }
  });

  test("dispatch checks out its tag and agent tags trigger the workflow", () => {
    const checkout = releaseWorkflow.jobs.release.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe(`refs/tags/\${{ github.event.inputs.tag || github.ref_name }}`);
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(releaseWorkflow.on.push.tags).toContain("nax-agent-v*.*.*");
    expect(releaseWorkflow.on.push.tags).toContain("nax-agent-v*.*.*-canary.*");
  });

  test.each([true, false])(
    "checkout requires the tag when a matching branch exists (tag present: %s)",
    (tagPresent) => {
      const fixture = makeReleaseCliFixture();
      const tag = "nax-agent-v0.1.0";
      try {
        const taggedCommit = fixture.git("rev-parse", "HEAD");
        if (tagPresent) fixture.git("tag", tag);
        fixture.git("checkout", "-b", tag);
        fixture.git("commit", "--allow-empty", "-m", "branch-only change");
        fixture.git("checkout", "main");
        const checkout = releaseWorkflow.jobs.release.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
        const ref = String(checkout?.with?.ref).replace(/\$\{\{[^}]+\}\}/, tag);
        if (tagPresent) {
          fixture.git("checkout", ref);
          expect(fixture.git("rev-parse", "HEAD")).toBe(taggedCommit);
        } else {
          expect(() => fixture.git("checkout", ref)).toThrow();
          expect(fixture.git("branch", "--show-current")).toBe("main");
        }
      } finally {
        cleanupTempDir(fixture.dir);
      }
    },
  );

  test.each([
    ["@nathapp/nax-agent", "0.1.0", "latest", "true", "false"],
    ["@nathapp/nax-agent", "1.0.0", "latest", "false", "false"],
    ["@nathapp/nax-agent", "0.1.1-canary.1", "canary", "true", "false"],
    ["@nathapp/nax-ai", "0.1.16", "latest", "true", "false"],
    ["@nathapp/nax", "0.83.2", "latest", "false", "true"],
  ])("release info for %s %s", (name, version, npmTag, prerelease, notify) => {
    const shell = makeReleaseShell();
    try {
      const result = shell.run("Set release info", { NAME: name, VERSION: version, TAG: `nax-agent-v${version}` });
      expect(result.status).toBe(0);
      expect(result.values).toContain(`npm_tag=${npmTag}\n`);
      expect(result.values).toContain(`prerelease=${prerelease}\n`);
      expect(result.values).toContain(`notify=${notify}\n`);
    } finally {
      cleanupTempDir(shell.dir);
    }
  });
});

describe("release checks and upload", () => {
  test("runs agent gates and stops at the first failing gate", () => {
    const shell = makeReleaseShell();
    try {
      const result = shell.run("Pre-publish checks");
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([
        "bun run check:all",
        "bun run typecheck",
        "bun run build",
        "bun run check:api",
        "bun run test:coverage",
        "bun run test:node",
        "bun run stage-publish",
      ]);
      const failed = shell.run("Pre-publish checks", { BUN_FAIL: "run build" });
      expect(failed.status).not.toBe(0);
      expect(failed.calls).toEqual(["bun run check:all", "bun run typecheck", "bun run build"]);
    } finally {
      cleanupTempDir(shell.dir);
    }
  });

  test("rejects tag/version mismatch", () => {
    const shell = makeReleaseShell();
    try {
      expect(shell.run("Validate version", { VERSION: "0.2.0" }).status).not.toBe(0);
      expect(shell.run("Validate version").status).toBe(0);
    } finally {
      cleanupTempDir(shell.dir);
    }
  });

  test("validates the selected package's published pin and propagates registry failure", () => {
    const shell = makeReleaseShell();
    try {
      const step = releaseStep("nax-ai pin is published");
      expect(step.if).toContain("@nathapp/nax-agent");
      expect(step["working-directory"]).toBe(`\${{ steps.pkg.outputs.dir }}`);
      expect(shell.run("nax-ai pin is published").calls).toEqual(["npm view @nathapp/nax-ai@0.1.16 version"]);
      for (const code of ["E404", "E401", "ETIMEDOUT"]) {
        expect(shell.run("nax-ai pin is published", { NPM_ERROR: code }).status).not.toBe(0);
      }
    } finally {
      cleanupTempDir(shell.dir);
    }
  });

  test.each([
    ["@nathapp/nax-agent", "0.1.1", "canary", "npm publish ./.publish/ --access public --tag canary --provenance"],
    ["@nathapp/nax", "0.83.2", "latest", "npm publish --access public --tag latest --provenance"],
    ["@nathapp/nax-ai", "0.1.16", "latest", "npm publish --access public --tag latest --provenance"],
  ])("publishes %s through its correct directory", (name, version, tag, call) => {
    const shell = makeReleaseShell();
    try {
      const result = shell.run("Publish to npm", { NAME: name, VERSION: version, NPM_TAG: tag });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([call]);
      if (name === "@nathapp/nax-agent") {
        expect(JSON.parse(readFileSync(join(shell.dir, ".publish/package.json"), "utf8")).publishConfig.tag).toBe(tag);
      }
    } finally {
      cleanupTempDir(shell.dir);
    }
  });

  test("0.1.0 verifies the existing artifact before skipping upload", () => {
    const shell = makeReleaseShell();
    try {
      const result = shell.run("Publish to npm");
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([
        "npm view @nathapp/nax-agent@0.1.0 version --json",
        "bun scripts/verify-bootstrap.ts",
      ]);
      const bad = shell.run("Publish to npm", { BUN_FAIL: "scripts/verify-bootstrap.ts" });
      expect(bad.status).not.toBe(0);
      expect(bad.calls.some((call) => call.startsWith("npm publish"))).toBe(false);
    } finally {
      cleanupTempDir(shell.dir);
    }
  });

  test("only E404 permits a first upload; registry failures stop", () => {
    const shell = makeReleaseShell();
    try {
      const absent = shell.run("Publish to npm", { NPM_ERROR: "E404" });
      expect(absent.status).toBe(0);
      expect(absent.calls.at(-1)).toBe("npm publish ./.publish/ --access public --tag latest --provenance");
      for (const code of ["ETIMEDOUT", "E401"]) {
        const result = shell.run("Publish to npm", { NPM_ERROR: code });
        expect(result.status).not.toBe(0);
        expect(result.calls.some((call) => call.startsWith("npm publish"))).toBe(false);
      }
      expect(shell.run("Publish to npm", { VERSION: "0.1.1", NPM_PUBLISH_EXIT: "1" }).status).not.toBe(0);
    } finally {
      cleanupTempDir(shell.dir);
    }
  });

  test("requires an OIDC-capable npm version", () => {
    const shell = makeReleaseShell();
    try {
      expect(shell.run("Validate npm version", { NPM_VERSION: "11.5.0" }).status).not.toBe(0);
      expect(shell.run("Validate npm version", { NPM_VERSION: "11.5.1" }).status).toBe(0);
    } finally {
      cleanupTempDir(shell.dir);
    }
  });
});
