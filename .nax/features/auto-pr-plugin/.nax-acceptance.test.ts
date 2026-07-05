import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { buildTitle, buildBody } from "../../../src/plugins/builtin/auto-pr/pr-body";
import { findPrTemplate } from "../../../src/plugins/builtin/auto-pr/template";
import {
  detectForge,
  openDraft,
  hasOpenPr,
  _forgeDeps,
} from "../../../src/plugins/builtin/auto-pr/forge";
import { autoPrPlugin } from "../../../src/plugins/builtin/auto-pr";
import { loadPlugins } from "../../../src/plugins/loader";
import type { PostRunContext } from "../../../src/plugins/extensions";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type TestCtx = PostRunContext & Record<string, unknown>;

const noop = async () => ({ exitCode: 0, stdout: "", stderr: "" });

function makeCtx(overrides: Record<string, unknown> = {}): TestCtx {
  return {
    runId: "test-run",
    feature: "auto-pr-plugin",
    workdir: "/tmp/test",
    prdPath: ".nax/features/auto-pr-plugin/prd.json",
    branch: "feat/auto-pr-plugin",
    totalDurationMs: 192_000,
    totalCost: 0.42,
    storySummary: { completed: 4, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0.71.0",
    pluginConfig: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    config: { autoPr: { enabled: true } },
    ...overrides,
  } as TestCtx;
}

// ---------------------------------------------------------------------------
// US-001: Config schema
// ---------------------------------------------------------------------------

describe("US-001: autoPr config schema", () => {
  test("AC-1: NaxConfigSchema.parse({}).autoPr.enabled is false", () => {
    const config = NaxConfigSchema.parse({}) as any;
    expect(config.autoPr.enabled).toBe(false);
  });

  test("AC-2: NaxConfigSchema.parse({}).autoPr.draft is true", () => {
    const config = NaxConfigSchema.parse({}) as any;
    expect(config.autoPr.draft).toBe(true);
  });

  test("AC-3: parse({ autoPr: { enabled: true } }) yields enabled=true AND draft=true", () => {
    const config = NaxConfigSchema.parse({ autoPr: { enabled: true } }) as any;
    expect(config.autoPr.enabled).toBe(true);
    expect(config.autoPr.draft).toBe(true);
  });

  test("AC-4: safeParse({ autoPr: { enabled: 'yes' } }).success is false", () => {
    const result = NaxConfigSchema.safeParse({ autoPr: { enabled: "yes" } });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// US-002: buildTitle
// ---------------------------------------------------------------------------

describe("US-002: buildTitle", () => {
  test("AC-5: buildTitle returns 'feat: auto-pr-plugin'", () => {
    const title = buildTitle({
      feature: "auto-pr-plugin",
      stories: [],
      cost: 0,
      duration: 0,
      prdPath: "",
    } as any);
    expect(title).toBe("feat: auto-pr-plugin");
  });
});

// ---------------------------------------------------------------------------
// US-002: buildBody
// ---------------------------------------------------------------------------

describe("US-002: buildBody", () => {
  test("AC-6: buildBody(ctx, null) contains nax-finish review banner", () => {
    const body = buildBody(makeCtx(), null);
    expect(body).toContain(
      "Auto-opened by nax — review pending. Run nax-finish before merge.",
    );
  });

  test("AC-7: story table has 1 header + N data rows; data rows match | US-XXX |", () => {
    const stories = [
      { id: "US-001", title: "Config foundation", acceptanceCriteria: ["a", "b", "c", "d"] },
      { id: "US-002", title: "Body helpers", acceptanceCriteria: ["a", "b"] },
    ] as any[];
    const body = buildBody(makeCtx({ stories }), null);

    // Keep pipe rows that are NOT separator rows (|---|---|)
    const tableRows = body
      .split("\n")
      .filter(
        (line) =>
          line.trim().startsWith("|") && !line.match(/^\s*\|[\s\-:|]+\|\s*$/),
      );

    expect(tableRows.length).toBe(stories.length + 1);
    // Each data row (after the header) contains | US-XXX |
    for (const row of tableRows.slice(1)) {
      expect(row).toMatch(/\|\s*US-\d+\s*\|/);
    }
  });

  test("AC-8: storySummary { completed:3, skipped:1 } reports '3 passed' and '1 skipped'", () => {
    const body = buildBody(
      makeCtx({ storySummary: { completed: 3, failed: 0, skipped: 1, paused: 0 } }),
      null,
    );
    expect(body).toContain("3 passed");
    expect(body).toContain("1 skipped");
  });

  test("AC-9: buildBody with template ends with template text and contains '---\\n\\n## Checklist'", () => {
    const template = "## Checklist\n- [ ] x";
    const body = buildBody(makeCtx(), template);
    expect(body.endsWith(template)).toBe(true);
    expect(body).toContain("---\n\n## Checklist");
  });

  test("AC-10: buildBody(ctx, null) does not contain '---'", () => {
    const body = buildBody(makeCtx(), null);
    expect(body).not.toContain("---");
  });
});

// ---------------------------------------------------------------------------
// US-002: findPrTemplate
// ---------------------------------------------------------------------------

describe("US-002: findPrTemplate", () => {
  test("AC-11: returns content when .github/pull_request_template.md resolves", async () => {
    const result = await findPrTemplate("/wd", "github", {
      readText: async (p) =>
        p === ".github/pull_request_template.md" ? "template content" : null,
      run: noop,
    });
    expect(result).toBe("template content");
  });

  test("AC-12: .github/PULL_REQUEST_TEMPLATE.md takes precedence over docs/PULL_REQUEST_TEMPLATE.md", async () => {
    const result = await findPrTemplate("/wd", "github", {
      readText: async (p) => {
        if (p === ".github/PULL_REQUEST_TEMPLATE.md") return "github content";
        if (p === "docs/PULL_REQUEST_TEMPLATE.md") return "docs content";
        return null;
      },
      run: noop,
    });
    expect(result).toBe("github content");
  });

  test("AC-13: gitlab returns .gitlab/merge_request_templates/Default.md content", async () => {
    const result = await findPrTemplate("/wd", "gitlab", {
      readText: async (p) =>
        p === ".gitlab/merge_request_templates/Default.md"
          ? "gitlab default content"
          : null,
      run: noop,
    });
    expect(result).toBe("gitlab default content");
  });

  test("AC-14: returns null when all template paths resolve to null", async () => {
    const result = await findPrTemplate("/wd", "github", {
      readText: async () => null,
      run: noop,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// US-003: detectForge
// ---------------------------------------------------------------------------

describe("US-003: detectForge", () => {
  test("AC-15: detectForge('git@github.com:owner/repo.git') returns 'github'", () => {
    expect(detectForge("git@github.com:owner/repo.git")).toBe("github");
  });

  test("AC-16: detectForge('https://gitlab.com/owner/repo.git') returns 'gitlab'", () => {
    expect(detectForge("https://gitlab.com/owner/repo.git")).toBe("gitlab");
  });

  test("AC-17: detectForge('https://example.com/owner/repo.git') returns null", () => {
    expect(detectForge("https://example.com/owner/repo.git")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// US-003: openDraft — argv composition and result parsing
// ---------------------------------------------------------------------------

describe("US-003: openDraft", () => {
  test("AC-18: github draft=true uses [gh,pr,create,--draft,...] and --head=my-branch", async () => {
    let capturedArgv: string[] = [];
    const origRun = _forgeDeps.run;
    _forgeDeps.run = async (argv) => {
      capturedArgv = argv;
      return { exitCode: 0, stdout: "https://github.com/owner/repo/pull/1\n", stderr: "" };
    };
    try {
      await openDraft({
        forge: "github",
        branch: "my-branch",
        draft: true,
        title: "...",
        body: "...",
        cwd: "/tmp",
      });
      expect(capturedArgv[0]).toBe("gh");
      expect(capturedArgv[1]).toBe("pr");
      expect(capturedArgv[2]).toBe("create");
      expect(capturedArgv[3]).toBe("--draft");
      expect(capturedArgv.some((a) => /--head=my-branch/.test(a))).toBe(true);
    } finally {
      _forgeDeps.run = origRun;
    }
  });

  test("AC-19: gitlab draft=true uses [glab,mr,create,--draft,...] and --source-branch=my-branch", async () => {
    let capturedArgv: string[] = [];
    const origRun = _forgeDeps.run;
    _forgeDeps.run = async (argv) => {
      capturedArgv = argv;
      return {
        exitCode: 0,
        stdout: "https://gitlab.com/owner/repo/-/merge_requests/1\n",
        stderr: "",
      };
    };
    try {
      await openDraft({
        forge: "gitlab",
        branch: "my-branch",
        draft: true,
        title: "...",
        body: "...",
        cwd: "/tmp",
      });
      expect(capturedArgv[0]).toBe("glab");
      expect(capturedArgv[1]).toBe("mr");
      expect(capturedArgv[2]).toBe("create");
      expect(capturedArgv[3]).toBe("--draft");
      expect(capturedArgv.some((a) => /--source-branch=my-branch/.test(a))).toBe(true);
    } finally {
      _forgeDeps.run = origRun;
    }
  });

  test("AC-20: draft=false argv does not include '--draft'", async () => {
    let capturedArgv: string[] = [];
    const origRun = _forgeDeps.run;
    _forgeDeps.run = async (argv) => {
      capturedArgv = argv;
      return { exitCode: 0, stdout: "https://github.com/owner/repo/pull/1\n", stderr: "" };
    };
    try {
      await openDraft({
        forge: "github",
        branch: "my-branch",
        draft: false,
        title: "...",
        body: "...",
        cwd: "/tmp",
      });
      expect(capturedArgv.includes("--draft")).toBe(false);
    } finally {
      _forgeDeps.run = origRun;
    }
  });

  test("AC-21: exitCode=0 returns success=true and trimmed url", async () => {
    const origRun = _forgeDeps.run;
    _forgeDeps.run = async () => ({
      exitCode: 0,
      stdout: "https://github.com/owner/repo/pull/123\n",
      stderr: "",
    });
    try {
      const result = await openDraft({
        forge: "github",
        branch: "my-branch",
        draft: true,
        title: "...",
        body: "...",
        cwd: "/tmp",
      });
      expect(result.success).toBe(true);
      expect(result.url).toBe("https://github.com/owner/repo/pull/123");
    } finally {
      _forgeDeps.run = origRun;
    }
  });

  test("AC-22: exitCode=1 returns success=false", async () => {
    const origRun = _forgeDeps.run;
    _forgeDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "error message" });
    try {
      const result = await openDraft({
        forge: "github",
        branch: "my-branch",
        draft: true,
        title: "...",
        body: "...",
        cwd: "/tmp",
      });
      expect(result.success).toBe(false);
    } finally {
      _forgeDeps.run = origRun;
    }
  });
});

// ---------------------------------------------------------------------------
// US-003: hasOpenPr
// ---------------------------------------------------------------------------

describe("US-003: hasOpenPr", () => {
  test("AC-23: returns true when stdout is non-empty JSON array", async () => {
    const origRun = _forgeDeps.run;
    _forgeDeps.run = async () => ({
      exitCode: 0,
      stdout: '[{"number": 42}]',
      stderr: "",
    });
    try {
      const result = await hasOpenPr({ forge: "github", branch: "my-branch", cwd: "/tmp" });
      expect(result).toBe(true);
    } finally {
      _forgeDeps.run = origRun;
    }
  });

  test("AC-24: returns false when stdout is empty JSON array", async () => {
    const origRun = _forgeDeps.run;
    _forgeDeps.run = async () => ({ exitCode: 0, stdout: "[]", stderr: "" });
    try {
      const result = await hasOpenPr({ forge: "github", branch: "my-branch", cwd: "/tmp" });
      expect(result).toBe(false);
    } finally {
      _forgeDeps.run = origRun;
    }
  });
});

// ---------------------------------------------------------------------------
// US-004: autoPrPlugin.shouldRun
// ---------------------------------------------------------------------------

describe("US-004: autoPrPlugin.shouldRun", () => {
  test("AC-25: returns false when config.autoPr.enabled is false", async () => {
    const ctx = makeCtx({ config: { autoPr: { enabled: false } } });
    const result = await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx);
    expect(result).toBe(false);
  });

  test("AC-26: returns false when storySummary.failed > 0", async () => {
    const ctx = makeCtx({
      storySummary: { failed: 1, completed: 5, skipped: 0, paused: 0 },
    });
    const result = await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx);
    expect(result).toBe(false);
  });

  test("AC-27: returns false when storySummary.paused > 0", async () => {
    const ctx = makeCtx({
      storySummary: { failed: 0, completed: 5, skipped: 0, paused: 1 },
    });
    const result = await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx);
    expect(result).toBe(false);
  });

  test("AC-28: returns false when storySummary.completed === 0", async () => {
    const ctx = makeCtx({
      storySummary: { failed: 0, completed: 0, skipped: 0, paused: 0 },
    });
    const result = await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx);
    expect(result).toBe(false);
  });

  test("AC-29: returns false when detectForge stub returns null", async () => {
    const ctx = makeCtx({ detectForge: () => null });
    const result = await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx);
    expect(result).toBe(false);
  });

  test("AC-30: returns false and calls logger.warn when hasOpenPr returns true", async () => {
    const warnMessages: string[] = [];
    const ctx = makeCtx({
      logger: {
        debug: () => {},
        info: () => {},
        warn: (msg: string) => {
          warnMessages.push(msg);
        },
        error: () => {},
      },
      detectForge: () => "github",
      hasOpenPr: async () => true,
    });
    const result = await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx);
    expect(result).toBe(false);
    expect(
      warnMessages.some((m) => m.includes("already open") || m.includes("skip")),
    ).toBe(true);
  });

  test("AC-31: returns true when enabled, no failures, forge detected, no open PR", async () => {
    const ctx = makeCtx({
      config: { autoPr: { enabled: true } },
      storySummary: { failed: 0, completed: 3, skipped: 0, paused: 0 },
      detectForge: () => "github",
      hasOpenPr: async () => false,
    });
    const result = await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// US-004: autoPrPlugin.execute
// ---------------------------------------------------------------------------

describe("US-004: autoPrPlugin.execute", () => {
  test("AC-32: happy path returns success=true with PR url", async () => {
    const ctx = makeCtx({
      detectForge: () => "github",
      findPrTemplate: async () => null,
      openDraft: async () => ({
        success: true,
        url: "https://github.com/owner/repo/pull/123",
        message: "PR opened",
      }),
    });
    const result = await autoPrPlugin.extensions.postRunAction!.execute(ctx);
    expect(result.success).toBe(true);
    expect(result.url).toBe("https://github.com/owner/repo/pull/123");
  });

  test("AC-33: returns { success: false, message } when openDraft returns failure — no throw", async () => {
    const ctx = makeCtx({
      detectForge: () => "github",
      findPrTemplate: async () => null,
      openDraft: async () => ({ success: false, message: "forge exited with 1" }),
    });
    const result = await autoPrPlugin.extensions.postRunAction!.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.message).toBe("forge exited with 1");
  });

  test("AC-34: returns { success: false } and calls logger.warn once when openDraft throws; no console.*", async () => {
    const warnCalls: string[] = [];
    let consoleWarnCalled = false;
    let consoleErrorCalled = false;
    let consoleLogCalled = false;
    const origWarn = console.warn;
    const origError = console.error;
    const origLog = console.log;
    console.warn = () => {
      consoleWarnCalled = true;
    };
    console.error = () => {
      consoleErrorCalled = true;
    };
    console.log = () => {
      consoleLogCalled = true;
    };

    try {
      const ctx = makeCtx({
        logger: {
          debug: () => {},
          info: () => {},
          warn: (msg: string) => {
            warnCalls.push(msg);
          },
          error: () => {},
        },
        detectForge: () => "github",
        findPrTemplate: async () => null,
        openDraft: async () => {
          throw new Error("ENOENT: gh not found");
        },
      });
      const result = await autoPrPlugin.extensions.postRunAction!.execute(ctx);
      expect(result.success).toBe(false);
      expect(warnCalls.length).toBe(1);
      expect(consoleWarnCalled).toBe(false);
      expect(consoleErrorCalled).toBe(false);
      expect(consoleLogCalled).toBe(false);
    } finally {
      console.warn = origWarn;
      console.error = origError;
      console.log = origLog;
    }
  });
});

// ---------------------------------------------------------------------------
// US-004: Plugin registration
// ---------------------------------------------------------------------------

describe("US-004: loadPlugins registration", () => {
  test("AC-35: loadPlugins with disabled=[] returns registry containing 'nax-auto-pr' action", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-pr-reg-"));
    const registry = await loadPlugins(
      join(root, "global"),
      join(root, "project"),
      [],
      root,
      [],
    );
    const actions = registry.getPostRunActions();
    expect(actions.some((a) => a.name === "nax-auto-pr")).toBe(true);
  });
});