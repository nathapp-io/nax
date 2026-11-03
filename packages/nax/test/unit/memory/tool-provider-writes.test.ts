/**
 * tool-provider-writes.test.ts — the provider's `save` and `forget` tools, and the
 * failure line each of the four tools answers with.
 *
 * Covers US-009 AC-1..AC-12: a save that hands the host the note the model wrote in
 * the scope it named and answers with the result the host resolved, a save refused
 * for its shape before the host is asked, a save the store refuses (the reason the
 * model gets back), a forget that hands the host the scope, slug and reason, a
 * forget of a note the repository owns (the read-only refusal, which names the file
 * to edit), a forget of a note no scope holds (the same `no note` line `get`
 * answers with), and the two throws that are not refusals at all — a search and a
 * save that fail, which come back as `isError` rather than escaping the tool.
 *
 * Everything runs against the real host over a temp global directory and a temp
 * repository, with its write and search methods wrapped in `mock()` so a case can
 * assert the call the host got — and, for a refused input, that the host was never
 * asked at all. The wrapping is also how a failing or refusing host is driven: the
 * mock stands in for the host's own method, so no `_deps` seam is touched.
 */

import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  MemoryForgetResult,
  MemoryHit,
  MemoryNoteWrite,
  MemorySaveResult,
  MemoryScope,
  ProviderTool,
  ToolProvider,
  ToolResult,
} from "@nathapp/nax-agent";
import { cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { NaxError } from "@/errors";
import { createMemoryHost, createMemoryToolProvider, type MemoryHost, type MemorySearchInput } from "@/memory";

/** The Design's example repo note, verbatim: the note only the repository holds. */
const STAGING_DB_NOTE = `---
id: staging-db
slug: staging-db
type: project
scope: project
description: the staging database is shared; never reset it
source: human
updatedAt: 2026-11-02T08:00:00Z
status: active
---

Ask in #infra before running migrations against staging.
`;

/** The run context a tool is handed; the memory tools read the host, not the root. */
const RUN_CONTEXT = { root: "/workspace", resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 };

/** The note AC-1 saves, as the model writes it: no scope, so the tool defaults to project. */
const REPLAY_BUDGET_INPUT = {
  slug: "replay-budget",
  type: "project",
  description: "replay budget",
  body: "2048 MiB",
};

/** What the host answers a forget of `old` with, when a case stubs the write. */
const FORGET_RESULT: MemoryForgetResult = { slug: "old", status: "deleted", delivered: true };

describe("memory tool provider writes", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let host: MemoryHost;
  let provider: ToolProvider;
  let saveSpy: Mock<(write: MemoryNoteWrite) => Promise<MemorySaveResult>>;
  let forgetSpy: Mock<
    (input: {
      readonly scope: MemoryScope;
      readonly slug: string;
      readonly reason: string;
    }) => Promise<MemoryForgetResult>
  >;
  let searchSpy: Mock<(query: MemorySearchInput) => Promise<readonly MemoryHit[]>>;
  /** What the last save reached the real host for: the result the tool has to echo. */
  let resolvedSave: MemorySaveResult | undefined;
  let savedGlobalEnv: string | undefined;

  /** The repository's team-note directory. */
  function repoMemoryDir(): string {
    return join(repoRoot, ".nax", "memory");
  }

  /** Commit the repository's `staging-db` note: the one a forget has to refuse. */
  function writeRepoNote(): void {
    mkdirSync(repoMemoryDir(), { recursive: true });
    writeFileSync(join(repoMemoryDir(), "staging-db.md"), STAGING_DB_NOTE);
  }

  /**
   * The real host, with the three calls these cases assert wrapped so the call it
   * got can be read back. The wrapper delegates, so a call reaches the real write.
   */
  async function openHost(): Promise<void> {
    const real = await createMemoryHost({ config: makeNaxConfig(), repoRoot, source: "nax-chat", logger });
    if (real === null) throw new Error("memory must be enabled for this fixture");
    saveSpy = mock(async (write: MemoryNoteWrite) => {
      resolvedSave = await real.save(write);
      return resolvedSave;
    });
    forgetSpy = mock((request: { readonly scope: MemoryScope; readonly slug: string; readonly reason: string }) =>
      real.forget(request),
    );
    searchSpy = mock((query: MemorySearchInput) => real.search(query));
    host = { ...real, save: saveSpy, forget: forgetSpy, search: searchSpy };
    provider = createMemoryToolProvider(host);
  }

  /** Run one of the provider's tools, as the agent's session would. */
  async function run(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool: ProviderTool | undefined = (await provider.tools(repoRoot)).find(
      (candidate) => candidate.localName === name,
    );
    if (tool === undefined) throw new Error(`provider has no tool ${name}`);
    return tool.run(input, RUN_CONTEXT);
  }

  /** The JSON object a successful write tool handed the model. */
  async function parsed(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await run(name, input);
    expect(result.isError).toBeUndefined();
    const body: Record<string, unknown> = JSON.parse(result.content);
    return body;
  }

  beforeEach(async () => {
    globalDir = makeTempDir("nax-tool-writes-global-");
    repoRoot = makeTempDir("nax-tool-writes-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    await openHost();
  });

  afterEach(() => {
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  describe("save", () => {
    test("AC-1 hands the host the four fields, in the project scope", async () => {
      await run("save", REPLAY_BUDGET_INPUT);

      expect(saveSpy.mock.calls[0]?.[0]).toEqual({
        slug: "replay-budget",
        type: "project",
        scope: "project",
        description: "replay budget",
        body: "2048 MiB",
      });
    });

    test("AC-2 answers the result the host resolved", async () => {
      const body = await parsed("save", REPLAY_BUDGET_INPUT);

      expect(resolvedSave).toEqual({ slug: "replay-budget", status: "active", delivered: true });
      expect(body).toEqual({
        slug: resolvedSave?.slug,
        status: resolvedSave?.status,
        delivered: resolvedSave?.delivered,
      });
    });

    test("AC-3 refuses a save with no description", async () => {
      const result = await run("save", { slug: "replay-budget", type: "project", body: "2048 MiB" });

      expect(result.isError).toBe(true);
    });

    test("AC-4 does not reach the host for that save", async () => {
      await run("save", { slug: "replay-budget", type: "project", body: "2048 MiB" });

      expect(saveSpy).not.toHaveBeenCalled();
    });

    test("AC-5 reports the store's refusal with its reason", async () => {
      saveSpy.mockImplementation(async () => {
        throw new NaxError("secret (aws) must not be stored", "MEMORY_WRITE_REFUSED", { stage: "memory" });
      });

      const result = await run("save", REPLAY_BUDGET_INPUT);

      expect(result).toEqual({ isError: true, content: "[memory] save refused: secret (aws) must not be stored" });
    });

    test("AC-12 resolves, rather than rejecting, when the host throws something else", async () => {
      saveSpy.mockImplementation(async () => {
        throw new Error("disk full");
      });

      const result = await run("save", REPLAY_BUDGET_INPUT);

      expect(result).toEqual({ isError: true, content: "[memory] save failed: disk full" });
    });
  });

  describe("forget", () => {
    test("AC-6 hands the host the scope, slug and reason", async () => {
      forgetSpy.mockImplementation(async () => FORGET_RESULT);

      await run("forget", { slug: "old", reason: "stale" });

      expect(forgetSpy).toHaveBeenCalledWith({ scope: "project", slug: "old", reason: "stale" });
    });

    test("AC-7 answers the result the host resolved", async () => {
      forgetSpy.mockImplementation(async () => FORGET_RESULT);

      const body = await parsed("forget", { slug: "old", reason: "stale" });

      expect(body).toEqual({
        slug: FORGET_RESULT.slug,
        status: FORGET_RESULT.status,
        delivered: FORGET_RESULT.delivered,
      });
    });

    test("AC-8 reports the read-only refusal, naming the repository file to edit", async () => {
      writeRepoNote();

      const result = await run("forget", { slug: "staging-db", reason: "stale" });

      expect(result.isError).toBe(true);
      expect(result.content.startsWith("[memory] ")).toBe(true);
      expect(result.content).toContain(".nax/memory/");
    });

    test("AC-9 answers a slug no scope holds the way get does", async () => {
      const result = await run("forget", { slug: "old", reason: "stale" });

      expect(result).toEqual({ isError: true, content: "[memory] no note project/old" });
    });

    test("AC-10 refuses a forget with no reason without reaching the host", async () => {
      const result = await run("forget", { slug: "old" });

      expect(result.isError).toBe(true);
      expect(forgetSpy).not.toHaveBeenCalled();
    });
  });

  describe("search failure", () => {
    test("AC-11 reports a failing search instead of throwing at the model", async () => {
      searchSpy.mockImplementation(async () => {
        throw new Error("disk full");
      });

      const result = await run("search", { text: "staging" });

      expect(result).toEqual({ isError: true, content: "[memory] search failed: disk full" });
    });
  });
});
