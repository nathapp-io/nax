/**
 * tool-provider.test.ts — the `nax-memory` static tool provider.
 *
 * Covers US-008 AC-1..AC-19: the provider's identity (`id`, `kind`, `stages`), the
 * four tools and their order, `get` over a real host (a note the repository holds,
 * an absent slug, a slug that is not a slug at all — refused before the host is
 * asked — and an explicit user scope), `search` (the default limit of 10, the hits
 * payload, and a limit outside 1-50 refused before the host is asked), the
 * instructions the provider hands a session, and both barrel exports.
 *
 * Everything runs against the real host over a temp global directory and a temp
 * repository, so the note `get` reads is the file a teammate committed rather than
 * a mock. The host's two reads are wrapped in `mock()` so a case can assert the
 * call it got — and, for the refused inputs, that the host was never asked at all.
 *
 * The write tools and the failure line each of the four tools answers with are
 * covered in `tool-provider-writes.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryHit, MemoryNote, MemoryScope, ProviderTool, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import { MEMORY_SLUG_RE } from "@nathapp/nax-agent";
import { cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import {
  createMemoryHost,
  createMemoryToolProvider,
  MEMORY_TOOL_PROVIDER_ID,
  type MemoryHost,
  type MemorySearchInput,
} from "@/memory";
import { buildMemoryToolInstructions } from "@/prompts";

/** The Design's example repo note, verbatim. */
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

describe("createMemoryToolProvider", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let host: MemoryHost;
  let provider: ToolProvider;
  let getNoteSpy: Mock<(scope: MemoryScope, slug: string) => Promise<MemoryNote | null>>;
  let searchSpy: Mock<(query: MemorySearchInput) => Promise<readonly MemoryHit[]>>;
  let savedGlobalEnv: string | undefined;

  /** The repository's team-note directory. */
  function repoMemoryDir(): string {
    return join(repoRoot, ".nax", "memory");
  }

  /**
   * The real host, with its two reads wrapped so a case can assert the call it
   * got. The wrapper delegates, so the note and the hit are the host's own.
   */
  async function openHost(): Promise<MemoryHost> {
    const real = await createMemoryHost({ config: makeNaxConfig(), repoRoot, source: "nax-chat", logger });
    if (real === null) throw new Error("memory must be enabled for this fixture");
    getNoteSpy = mock((scope: MemoryScope, slug: string) => real.getNote(scope, slug));
    searchSpy = mock((query: MemorySearchInput) => real.search(query));
    return { ...real, getNote: getNoteSpy, search: searchSpy };
  }

  /** The tool of the provider's current `tools()` list that goes by `name`. */
  async function toolFor(name: string): Promise<ProviderTool> {
    const tool = (await provider.tools(repoRoot)).find((candidate) => candidate.localName === name);
    if (tool === undefined) throw new Error(`provider has no tool ${name}`);
    return tool;
  }

  /** Run one of the provider's tools, as the agent's session would. */
  async function run(name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
    const tool = await toolFor(name);
    return tool.run(input, RUN_CONTEXT);
  }

  /** The JSON object `get` or `search` handed the model. */
  async function parsed(name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await run(name, input);
    expect(result.isError).toBeUndefined();
    const body: Record<string, unknown> = JSON.parse(result.content);
    return body;
  }

  beforeEach(async () => {
    globalDir = makeTempDir("nax-tool-provider-global-");
    repoRoot = makeTempDir("nax-tool-provider-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    mkdirSync(repoMemoryDir(), { recursive: true });
    writeFileSync(join(repoMemoryDir(), "staging-db.md"), STAGING_DB_NOTE);
    host = await openHost();
    provider = createMemoryToolProvider(host);
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

  describe("shape", () => {
    test("AC-1 has the nax-memory id", () => {
      expect(provider.id).toBe("nax-memory");
      expect(provider.id).toBe(MEMORY_TOOL_PROVIDER_ID);
    });

    test("AC-2 is a static provider", () => {
      expect(provider.kind).toBe("static");
    });

    test("AC-3 attaches to every stage", () => {
      expect(provider.stages).toEqual(["*"]);
    });

    test("AC-4 offers get, search, save and forget in that order", async () => {
      expect((await provider.tools(repoRoot)).map((tool) => tool.localName)).toEqual([
        "get",
        "search",
        "save",
        "forget",
      ]);
    });
  });

  describe("input schemas", () => {
    /** The property schema a tool advertises for `property`. */
    async function propertyOf(name: string, property: string): Promise<Record<string, unknown>> {
      const schema = (await toolFor(name)).inputSchema;
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      return properties[property];
    }

    /** Every required string whose empty value the tool's own check refuses. */
    const REQUIRED_TEXT_FIELDS = [
      ["get", "slug"],
      ["search", "text"],
      ["save", "slug"],
      ["save", "type"],
      ["save", "description"],
      ["save", "body"],
      ["forget", "slug"],
      ["forget", "reason"],
    ] as const;

    test("[M1] every required string refuses the empty value the tool refuses", async () => {
      // The schema is the contract the model reads: a property that admits "" advertises an
      // input the tool then answers with `[memory] invalid …`, which no schema said it would.
      const unbounded: string[] = [];
      for (const [name, property] of REQUIRED_TEXT_FIELDS) {
        const schema = await propertyOf(name, property);
        if (schema.type !== "string" || schema.minLength !== 1) unbounded.push(`${name}.${property}`);
      }

      expect(unbounded).toEqual([]);
    });

    test("[M1] the slug get and forget check is the store's own pattern", async () => {
      for (const name of ["get", "forget"]) {
        expect(await propertyOf(name, "slug")).toMatchObject({ pattern: MEMORY_SLUG_RE.source });
      }
    });
  });

  describe("get", () => {
    test("AC-5 reads a note the repository holds", async () => {
      const note = await parsed("get", { slug: "staging-db" });

      expect(note.slug).toBe("staging-db");
    });

    test("AC-6 returns the note's body", async () => {
      const note = await parsed("get", { slug: "staging-db" });

      expect(note.body).toBe((await host.getNote("project", "staging-db"))?.body);
      expect(note.body).toContain("Ask in #infra");
    });

    test("AC-7 answers a slug no scope holds", async () => {
      expect(await run("get", { slug: "absent" })).toEqual({
        isError: true,
        content: "[memory] no note project/absent",
      });
    });

    test("AC-8 refuses a slug that is not a slug", async () => {
      const result = await run("get", { slug: "../x" });

      expect(result.isError).toBe(true);
    });

    test("AC-9 does not reach the host for that slug", async () => {
      await run("get", { slug: "../x" });

      expect(getNoteSpy).not.toHaveBeenCalled();
    });

    test("AC-10 reads the user scope the request names", async () => {
      await run("get", { slug: "pref", scope: "user" });

      expect(getNoteSpy).toHaveBeenCalledWith("user", "pref");
    });

    test("refuses a scope outside the enum without reaching the host", async () => {
      const result = await run("get", { slug: "staging-db", scope: "team" });

      expect(result.isError).toBe(true);
      expect(getNoteSpy).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    test("AC-11 searches with the default limit of 10", async () => {
      await run("search", { text: "staging" });

      expect(searchSpy.mock.calls[0]?.[0]).toMatchObject({ text: "staging", limit: 10 });
    });

    test("AC-12 answers { hits }", async () => {
      const result = await parsed("search", { text: "staging" });

      expect(Array.isArray(result.hits)).toBe(true);
      expect(result.hits).toEqual([expect.objectContaining({ slug: "staging-db", scope: "project" })]);
    });

    test("passes no scope on when the request names none, keeping the host's cross-scope search", async () => {
      await run("search", { text: "staging" });

      expect(searchSpy.mock.calls[0]?.[0]).not.toHaveProperty("scope");
    });

    test("searches only the scope the request names", async () => {
      const result = await run("search", { text: "staging", scope: "user" });

      expect(searchSpy.mock.calls[0]?.[0]).toMatchObject({ text: "staging", scope: "user" });
      expect(JSON.parse(result.content)).toEqual({ hits: [] });
    });

    test("AC-13 refuses a limit below 1 without searching", async () => {
      const result = await run("search", { text: "staging", limit: 0 });

      expect(result.isError).toBe(true);
      expect(searchSpy).not.toHaveBeenCalled();
    });

    test("AC-14 refuses a limit above 50 without searching", async () => {
      const result = await run("search", { text: "staging", limit: 51 });

      expect(result.isError).toBe(true);
      expect(searchSpy).not.toHaveBeenCalled();
    });
  });

  describe("instructions", () => {
    test("AC-15 is the memory protocol text", async () => {
      expect(await provider.instructions?.(repoRoot)).toBe(buildMemoryToolInstructions());
    });
  });

  describe("failure mapping", () => {
    test("reports a throwing read instead of throwing at the model", async () => {
      const failing: MemoryHost = {
        ...host,
        getNote: async () => {
          throw new Error("boom");
        },
      };
      const get = (await createMemoryToolProvider(failing).tools(repoRoot)).find((tool) => tool.localName === "get");
      if (get === undefined) throw new Error("provider has no get tool");

      const result = await get.run({ slug: "staging-db" }, RUN_CONTEXT);

      expect(result).toEqual({ isError: true, content: "[memory] get failed: boom" });
    });
  });
});

describe("buildMemoryToolInstructions", () => {
  test("AC-16 names the search tool", () => {
    expect(buildMemoryToolInstructions()).toContain("nax-memory__search");
  });

  test("AC-17 names the save tool", () => {
    expect(buildMemoryToolInstructions()).toContain("nax-memory__save");
  });

  test("AC-18 carries a Never sentence about secrets", () => {
    const sentences = buildMemoryToolInstructions().split(/(?<=\.)\s+/);
    const never = sentences.find((sentence) => sentence.startsWith("Never"));

    expect(never).toBeDefined();
    expect(never).toContain("secrets");
  });
});

describe("barrel exports", () => {
  test("AC-19 exports the provider and the instructions from their barrels", async () => {
    const memory = await import("@/memory");
    const prompts = await import("@/prompts");

    expect(typeof memory.createMemoryToolProvider).toBe("function");
    expect(typeof prompts.buildMemoryToolInstructions).toBe("function");
  });
});
