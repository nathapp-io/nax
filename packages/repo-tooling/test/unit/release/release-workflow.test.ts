// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions are compared as literal strings
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { LOCKSTEP_PACKAGES } from "#scripts/lib/lockstep";
import {
  allSteps,
  makeReleaseShell,
  publishAction,
  type ReleaseShell,
  releaseStep,
  releaseWorkflow,
  // biome-ignore lint/style/noRestrictedImports: the release harness is a test helper inside this package, not an entry
} from "../../helpers/release-shell";

const ACTION = "./.github/actions/publish-package";
const AGENT_GATES = [
  "bun run check:all",
  "bun run typecheck",
  "bun run build",
  "bun run check:api",
  "bun run test:coverage",
  "bun run test:node",
  "bun run stage-publish",
];
const UNPUBLISHED_ENV: Array<Record<string, string>> = [
  { NPM_VIEW_EMPTY: "1" },
  { NPM_ERROR: "E404" },
  { NPM_VIEW_VERSION: "0.83.7" },
];

function withShell<T>(fn: (shell: ReleaseShell) => T, opts?: { manifest?: Record<string, unknown> }): T {
  const shell = makeReleaseShell(opts);
  try {
    return fn(shell);
  } finally {
    cleanupTempDir(shell.dir);
  }
}

const publishJobs = Object.entries(releaseWorkflow.jobs).filter(([, job]) =>
  job.steps.some((step) => step.uses === ACTION),
);

describe("triggers and job graph", () => {
  test("only vX.Y.Z and vX.Y.Z-canary.N tags trigger a release", () => {
    expect(releaseWorkflow.on.push.tags).toEqual(["v*.*.*", "v*.*.*-canary.*"]);
  });

  test("publish jobs follow lockstep publish order, each needing the previous one", () => {
    const names = publishJobs.map(([, job]) => job.steps.find((step) => step.uses === ACTION)?.with?.name);
    expect(names).toEqual(LOCKSTEP_PACKAGES.map((p) => p.name));
    const ids = publishJobs.map(([id]) => id);
    for (const [i, id] of ids.entries()) {
      const needs = [releaseWorkflow.jobs[id]?.needs].flat();
      expect(needs).toContain("resolve");
      if (i > 0) expect(needs).toContain(ids[i - 1]);
    }
    expect([releaseWorkflow.jobs["github-release"]?.needs].flat()).toContain(ids.at(-1));
  });

  test.each(LOCKSTEP_PACKAGES.map((p) => [p.name, p.dir]))(
    "%s publishes from %s in the npm environment at the tagged commit",
    (name, dir) => {
      const job = publishJobs.find(([, j]) => j.steps.some((step) => step.with?.name === name))?.[1];
      expect(job?.environment).toBe("npm");
      const checkout = job?.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.ref).toBe("refs/tags/${{ needs.resolve.outputs.tag }}");
      expect(job?.steps.find((step) => step.uses === ACTION)?.with).toEqual({
        name,
        dir,
        version: "${{ needs.resolve.outputs.version }}",
        npm_tag: "${{ needs.resolve.outputs.npm_tag }}",
      });
    },
  );

  test("no run body interpolates an expression, and composite run steps declare bash", () => {
    for (const step of allSteps().filter((s) => s.run !== undefined)) {
      expect(step.run).not.toContain("${{");
    }
    for (const step of publishAction.runs.steps.filter((s) => s.run !== undefined)) {
      expect(step.shell).toBe("bash");
    }
  });

  test("every step after the published check is skipped for a version already on npm", () => {
    const steps = publishAction.runs.steps;
    const at = steps.findIndex((step) => step.id === "published");
    expect(at).toBeGreaterThan(0);
    for (const step of steps.slice(at + 1)) {
      expect(step.if ?? "").toContain("steps.published.outputs.skip != 'true'");
    }
  });
});

describe("resolve", () => {
  test.each([
    ["v0.84.0", "0.84.0", "latest", "false", "true"],
    ["v0.84.1-canary.2", "0.84.1-canary.2", "canary", "true", "false"],
  ])("%s", (tag, version, npmTag, prerelease, notify) =>
    withShell((shell) => {
      const result = shell.run("Set release info", { TAG: tag });
      expect(result.status).toBe(0);
      expect(result.values).toBe(
        `tag=${tag}\nversion=${version}\nnpm_tag=${npmTag}\nprerelease=${prerelease}\nnotify=${notify}\n`,
      );
    }),
  );

  test.each(["nax-ai-v0.1.16", "nax-agent-v0.84.0", "v0.84", "v0.84.0-rc.1", "v0.84.0;echo bad", "0.84.0", "v01.2.3"])(
    "rejects %s",
    (tag) =>
      withShell((shell) => {
        const result = shell.run("Set release info", { TAG: tag });
        expect(result.status).not.toBe(0);
        expect(result.values).toBe("");
      }),
  );

  test("checks every package against the tag's version before any publish job", () => {
    expect(releaseStep("Packages share the tag's version").run).toContain(
      'bun packages/repo-tooling/scripts/check-lockstep.ts --expect="$VERSION"',
    );
  });
});

describe("publish-package action", () => {
  test("a version already on npm is skipped", () =>
    withShell((shell) => {
      const result = shell.run("Already on npm", { NAME: "@nathapp/nax-ai" });
      expect(result.status).toBe(0);
      expect(result.values).toBe("skip=true\n");
    }));

  test.each(UNPUBLISHED_ENV)("an unpublished version is published (%j)", (env) =>
    withShell((shell) => {
      const result = shell.run("Already on npm", env);
      expect(result.status).toBe(0);
      expect(result.values).toBe("skip=false\n");
    }),
  );

  test.each(["E401", "ETIMEDOUT"])("a registry error %s stops the job", (code) =>
    withShell((shell) => {
      expect(shell.run("Already on npm", { NPM_ERROR: code }).status).not.toBe(0);
    }),
  );

  test.each([
    ["@nathapp/nax-ai", ["bun run lint", "bun run typecheck", "bun x vitest --run", "bun run build"]],
    ["@nathapp/nax-agent", AGENT_GATES],
    ["@nathapp/nax-agent-acp", AGENT_GATES],
    ["@nathapp/nax", ["bun run build"]],
  ])("%s runs its own gates", (name, gates) =>
    withShell((shell) => {
      const result = shell.run("Pre-publish checks", { NAME: name as string });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(gates as string[]);
    }),
  );

  test("the gates stop at the first failure", () =>
    withShell((shell) => {
      const result = shell.run("Pre-publish checks", { BUN_FAIL: "run build" });
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual(AGENT_GATES.slice(0, 3));
    }));

  test("nax-ai waits for nothing", () =>
    withShell((shell) => {
      const result = shell.run("Dependencies are on npm", { NAME: "@nathapp/nax-ai" });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([]);
    }));

  test.each(["@nathapp/nax", "@nathapp/nax-agent"])("%s waits for its exact nax-ai pin", (name) =>
    withShell((shell) => {
      const result = shell.run("Dependencies are on npm", { NAME: name });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(["npm view @nathapp/nax-ai@0.84.0 version"]);
    }),
  );

  test("nax-agent-acp waits for the nax-agent version its staged peer names", () =>
    withShell(
      (shell) => {
        const result = shell.run("Dependencies are on npm", { NAME: "@nathapp/nax-agent-acp" });
        expect(result.status).toBe(0);
        expect(result.calls).toEqual(["npm view @nathapp/nax-agent@0.84.0 version"]);
      },
      { manifest: { version: "0.84.0", peerDependencies: { "@nathapp/nax-agent": "^0.84.0" } } },
    ));

  test("a staged acp manifest without a caret peer fails without asking npm", () =>
    withShell(
      (shell) => {
        const result = shell.run("Dependencies are on npm", { NAME: "@nathapp/nax-agent-acp" });
        expect(result.status).not.toBe(0);
        expect(result.calls).toEqual([]);
      },
      { manifest: { version: "0.84.0" } },
    ));

  test("retries while the registry lags, then fails", () =>
    withShell((shell) => {
      const result = shell.run("Dependencies are on npm", { NPM_VIEW_EMPTY: "1", RETRY_DELAY: "0" });
      expect(result.status).not.toBe(0);
      expect(result.calls).toHaveLength(8);
    }));

  test.each(["@nathapp/nax-agent", "@nathapp/nax-agent-acp"])(
    "%s publishes its staged .publish/ with the dist-tag in the manifest too",
    (name) =>
      withShell((shell) => {
        const result = shell.run("Publish to npm", { NAME: name, NPM_TAG: "canary" });
        expect(result.status).toBe(0);
        expect(result.calls).toEqual(["npm publish ./.publish/ --access public --tag canary --provenance"]);
        const staged = JSON.parse(readFileSync(join(shell.dir, ".publish/package.json"), "utf8"));
        expect(staged.publishConfig.tag).toBe("canary");
      }),
  );

  test.each(["@nathapp/nax-ai", "@nathapp/nax"])("%s publishes its package directory", (name) =>
    withShell((shell) => {
      const result = shell.run("Publish to npm", { NAME: name });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(["npm publish --access public --tag latest --provenance"]);
    }),
  );

  test("a failed upload fails the job", () =>
    withShell((shell) => {
      expect(shell.run("Publish to npm", { NPM_PUBLISH_EXIT: "1" }).status).not.toBe(0);
    }));

  test("the package version must equal the tag's version", () =>
    withShell((shell) => {
      expect(shell.run("Validate version").status).toBe(0);
      expect(shell.run("Validate version", { VERSION: "0.84.1" }).status).not.toBe(0);
    }));

  test("requires an OIDC-capable npm", () =>
    withShell((shell) => {
      expect(shell.run("Validate npm version", { NPM_VERSION: "11.5.0" }).status).not.toBe(0);
      expect(shell.run("Validate npm version", { NPM_VERSION: "11.5.1" }).status).toBe(0);
    }));
});

describe("GitHub release", () => {
  test("collects each package's notes for the version and skips packages without any", () =>
    withShell((shell) => {
      mkdirSync(join(shell.dir, "packages/nax-agent"), { recursive: true });
      mkdirSync(join(shell.dir, "packages/nax-agent-acp"), { recursive: true });
      writeFileSync(
        join(shell.dir, "packages/nax-agent/CHANGELOG.md"),
        "# Changelog\n\n## [0.84.0] - 2026-10-10\n\n- Login.\n\n## [0.3.1] - 2026-10-07\n\n- Old.\n",
      );
      writeFileSync(
        join(shell.dir, "packages/nax-agent-acp/CHANGELOG.md"),
        "# Changelog\n\n## [0.3.1] - 2026-10-07\n\n- Old.\n",
      );
      const result = shell.run("Extract release notes");
      expect(result.status).toBe(0);
      expect(readFileSync(join(shell.dir, "release-notes.md"), "utf8")).toBe("## @nathapp/nax-agent\n\n- Login.\n\n");
    }));

  test("one GitHub Release carries the notes plus generated notes", () => {
    expect(releaseStep("Create GitHub Release").with).toEqual({
      tag_name: "${{ needs.resolve.outputs.tag }}",
      name: "${{ needs.resolve.outputs.tag }}",
      body_path: "${{ runner.temp }}/release-notes.md",
      prerelease: "${{ needs.resolve.outputs.prerelease }}",
      generate_release_notes: true,
    });
  });
});
