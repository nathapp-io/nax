import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ClientRequest, ResolvedModel } from "@nathapp/nax-ai";
import { createAgentSession, nativeBackend } from "#src/index";
import { _clientDeps, _resetNativeClient } from "#src/native/client";
import { _repositoryInstructionDeps, RepositoryInstructions } from "#src/native/session/repository-instructions";
import { createNativeSessionState, openNativeSession, systemFieldFor } from "#src/native/session/session";
import type { TranscriptDoc, TranscriptStore } from "#src/native/session/transcript-types";
import { NativeSessionAdapter, nativeSessionStateOf } from "#src/native/session-adapter";
import type { OpenSessionOpts } from "#src/session/session-types";
import { withInstructionAccess } from "#src/tools/instruction-access";
import { compileToolPolicy } from "#src/tools/policy";
import { createCodingToolRuntime } from "#src/tools/runtime";
import { withDerivedStream } from "#test/helpers/index";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nax-instructions-"));
  roots.push(root);
  const docs = new Map<string, TranscriptDoc>();
  const store: TranscriptStore = {
    load: async (id) => docs.get(id) ?? null,
    save: async (id, doc) => {
      docs.set(id, doc);
    },
    delete: async (id) => {
      docs.delete(id);
    },
    retainFailed: async () => {},
    markTurn: async () => {},
  };
  const put = async (path: string, text: string) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const opts = (directories: string[] = []): OpenSessionOpts => ({
    agentName: "native",
    workdir: root,
    resolvedPermissions: {
      mode: "default",
      toolGrants: [],
      bashApproval: "gated",
    },
    modelDef: { provider: "anthropic", model: "anthropic/test" },
    timeoutSeconds: 10,
    transcriptStore: store,
    instructionDirectories: directories,
  });
  return { root, store, docs, put, opts };
}

test("native opens the root to story package chain with AGENTS preference and CLAUDE fallback", async () => {
  const f = await fixture();
  await f.put("AGENTS.md", "ROOT RULE");
  await f.put("CLAUDE.md", "WRONG ROOT");
  await f.put("packages/CLAUDE.md", "INTERMEDIATE RULE");
  await f.put("packages/a/AGENTS.md", "PACKAGE A RULE");
  await f.put("packages/b/AGENTS.md", "UNRELATED B RULE");
  const state = createNativeSessionState();
  await openNativeSession(state, "one", {
    ...f.opts(["packages/a"]),
    systemPrompt: "HOST RULE",
  });
  const system = systemFieldFor(state, "one").system ?? "";
  expect(system).toContain("ROOT RULE");
  expect(system).toContain("INTERMEDIATE RULE");
  expect(system).toContain("PACKAGE A RULE");
  expect(system).toContain("HOST RULE");
  expect(system).not.toContain("WRONG ROOT");
  expect(system).not.toContain("UNRELATED B RULE");
  expect(system.indexOf("ROOT RULE")).toBeLessThan(system.indexOf("PACKAGE A RULE"));
});

test("persists instruction audit and reconstructs discovered scopes on resume without owner leaks", async () => {
  const f = await fixture();
  await f.put("AGENTS.md", "ROOT");
  await f.put("packages/b/AGENTS.md", "CROSS PACKAGE");
  const state = createNativeSessionState();
  await openNativeSession(state, "one", f.opts());
  await state.repositoryInstructions.get("one")?.discover("packages/b");
  await state.transcripts.get("one")?.store.save("one", { savedAt: "now", messages: [], owner: "owner" });
  const doc = f.docs.get("one");
  expect(doc?.instructionSources?.map((source) => source.path)).toEqual(["AGENTS.md", "packages/b/AGENTS.md"]);
  const resumed = createNativeSessionState();
  await openNativeSession(resumed, "one", {
    ...f.opts(),
    resume: true,
    transcriptOwner: "owner",
  });
  expect(systemFieldFor(resumed, "one").system).toContain("CROSS PACKAGE");
  const foreign = createNativeSessionState();
  await openNativeSession(foreign, "one", {
    ...f.opts(),
    resume: true,
    transcriptOwner: "different",
  });
  expect(systemFieldFor(foreign, "one").system).not.toContain("CROSS PACKAGE");
});

test("bounds imports, cycles, external symlinks, hidden credentials and directory escapes", async () => {
  const f = await fixture();
  const external = await fixture();
  await external.put("AGENTS.md", "OUTSIDE SECRET");
  await f.put(
    "AGENTS.md",
    "ROOT @docs/rules.md\n@docs/rules.md @../outside.md @.credentials/secret.md @docs/large.md @docs/external.md",
  );
  await f.put("docs/rules.md", "IMPORTED @../AGENTS.md");
  await f.put(".credentials/secret.md", "CREDENTIAL SECRET");
  await f.put("docs/large.md", "BIG SECRET".repeat(4000));
  await symlink(join(external.root, "AGENTS.md"), join(f.root, "docs/external.md"));
  await f.put("packages/a/CLAUDE.md", "A");
  await f.put("packages/b/AGENTS.md", "B");
  const state = createNativeSessionState();
  await openNativeSession(state, "one", f.opts(["../outside", "packages/a"]));
  const system = systemFieldFor(state, "one").system ?? "";
  expect(system).toContain("IMPORTED");
  expect(system).not.toContain("OUTSIDE SECRET");
  expect(system).not.toContain("CREDENTIAL SECRET");
  expect(system).not.toContain("BIG SECRET");
  expect(system.match(/IMPORTED/g)).toHaveLength(1);
  const sources = state.repositoryInstructions.get("one")?.sources ?? [];
  expect(sources.every((source) => /^[a-f0-9]{64}$/.test(source.hash))).toBe(true);
});

test("native discovers cross-package instructions before an authorized Write and sends them next round", async () => {
  const f = await fixture();
  await f.put("AGENTS.md", "ROOT");
  await f.put("packages/b/AGENTS.md", "CROSS PACKAGE RULE");
  const systems: string[] = [];
  let calls = 0;
  let writes = 0;
  const model: ResolvedModel = {
    id: "test",
    provider: "openai",
    protocol: "openai-responses",
    pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    supportsTools: true,
    thinkingLevels: [],
  };
  const realBuild = _clientDeps.build;
  try {
    _resetNativeClient();
    _clientDeps.build = async () =>
      withDerivedStream<Client>({
        model: async () => model,
        listModels: async () => [model],
        pricing: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
        stream: async function* () {},
        validate: () => {},
        complete: async (_model: ResolvedModel, request: ClientRequest) => {
          systems.push(request.system ?? "");
          calls++;
          return {
            text: calls <= 2 ? "" : "done",
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: calls <= 2 ? "tool_use" : "stop",
            ...(calls <= 2
              ? {
                  toolCalls: [
                    {
                      id: "write",
                      name: "Write",
                      input: { path: "packages/b/new.ts", content: "hello" },
                    },
                  ],
                }
              : {}),
          };
        },
      });
    const adapter = new NativeSessionAdapter();
    const handle = await adapter.openSession("native", {
      ...f.opts(),
      modelDef: { provider: "openai", model: "openai/test" },
    });
    const state = nativeSessionStateOf(adapter);
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy(
        [
          { tool: "Read", patterns: ["*"] },
          { tool: "Write", patterns: ["*"] },
        ],
        f.root,
      ),
      extraTools: [
        {
          name: "Write",
          description: "test",
          scope: { pathFields: ["path"] },
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
          run: async () => {
            writes += 1;
            expect(systemFieldFor(state, "native").system).toContain("CROSS PACKAGE RULE");
            return { content: "written" };
          },
        },
      ],
    });
    await adapter.sendTurn(handle, "go", {
      codingTools: runtime.advertised(["Write"]),
      interactionHandler: {
        onInteraction: async (request) => {
          if (request.kind !== "coding-tool") return null;
          const outcome = await runtime.callTool(request.name, request.input ?? {});
          return {
            answer: outcome.kind === "denied" ? outcome.reason : outcome.content,
          };
        },
      },
    });
    expect(writes).toBe(1);
    expect(systems[0]).not.toContain("CROSS PACKAGE RULE");
    expect(systems[1]).toContain("CROSS PACKAGE RULE");
  } finally {
    _clientDeps.build = realBuild;
    _resetNativeClient();
  }
});

test("missing and empty guides produce no fabricated guidance or fallback duplication", async () => {
  const f = await fixture();
  const state = createNativeSessionState();
  await openNativeSession(state, "missing", f.opts());
  expect(systemFieldFor(state, "missing")).toEqual({});
  await f.put("AGENTS.md", "  ");
  await f.put("CLAUDE.md", "FALLBACK MUST NOT WIN");
  await openNativeSession(state, "empty", f.opts());
  expect(systemFieldFor(state, "empty")).toEqual({});
});

test("preload respects denyPaths, protected imports and symlink canonical exclusions", async () => {
  const f = await fixture();
  await f.put("AGENTS.md", "ROOT @docs/private.md @docs/alias.md");
  await f.put("docs/private.md", "PROTECTED CONTENT");
  await f.put("docs/denied.md", "DENIED CONTENT");
  await symlink(join(f.root, "docs/denied.md"), join(f.root, "docs/alias.md"));
  await f.put("packages/a/AGENTS.md", "DENIED PACKAGE");
  const state = createNativeSessionState();
  await openNativeSession(state, "one", {
    ...f.opts(["packages/a"]),
    instructionDenyPaths: ["packages/a/**", "docs/denied.md"],
    instructionProtectedPaths: {
      gitExcludePathspecs: [],
      gitIgnorePatterns: [],
      trustStoreFile: join(f.root, "docs/private.md"),
    },
  });
  const system = systemFieldFor(state, "one").system ?? "";
  expect(system).toContain("ROOT");
  expect(system).not.toContain("PROTECTED CONTENT");
  expect(system).not.toContain("DENIED CONTENT");
  expect(system).not.toContain("DENIED PACKAGE");
});

test("batch scopes and concurrent sessions keep separate package guidance", async () => {
  const f = await fixture();
  await f.put("AGENTS.md", "ROOT");
  await f.put("packages/a/AGENTS.md", "A RULE");
  await f.put("packages/b/AGENTS.md", "B RULE");
  await f.put("packages/c/AGENTS.md", "C RULE");
  const one = createNativeSessionState(),
    two = createNativeSessionState();
  await Promise.all([
    openNativeSession(one, "same", f.opts(["packages/a", "packages/b"])),
    openNativeSession(two, "same", f.opts(["packages/c"])),
  ]);
  expect(systemFieldFor(one, "same").system).toContain("A RULE");
  expect(systemFieldFor(one, "same").system).toContain("B RULE");
  expect(systemFieldFor(one, "same").system).not.toContain("C RULE");
  expect(systemFieldFor(two, "same").system).toContain("C RULE");
  expect(systemFieldFor(two, "same").system).not.toContain("A RULE");
});

test("nested discovery and symlink aliases deduplicate source files", async () => {
  const f = await fixture();
  await f.put("AGENTS.md", "ROOT");
  await f.put("packages/a/AGENTS.md", "A RULE");
  await f.put("packages/a/nested/AGENTS.md", "NESTED RULE");
  await symlink(join(f.root, "packages/a"), join(f.root, "alias"));
  const state = createNativeSessionState();
  await openNativeSession(state, "one", f.opts(["packages/a"]));
  await Promise.all([
    state.repositoryInstructions.get("one")?.discover("alias/nested"),
    state.repositoryInstructions.get("one")?.discover("packages/a/nested"),
  ]);
  expect(systemFieldFor(state, "one").system).toContain("NESTED RULE");
  expect(state.repositoryInstructions.get("one")?.sources.map((source) => source.path)).toEqual([
    "AGENTS.md",
    "packages/a/AGENTS.md",
    "packages/a/nested/AGENTS.md",
  ]);
});

test("denied and missing Read targets do not discover package guidance", async () => {
  const f = await fixture();
  await f.put("packages/b/AGENTS.md", "B RULE");
  const state = createNativeSessionState();
  await openNativeSession(state, "one", f.opts());
  const instructions = state.repositoryInstructions.get("one");
  if (instructions === undefined) throw new Error("missing instructions");
  const run = async (deny: boolean) => {
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy(
        [{ tool: "Read", patterns: ["*"] }],
        f.root,
        deny ? { denyRules: [{ tool: "Read", patterns: ["packages/b/**"] }] } : {},
      ),
    });
    return withInstructionAccess(
      async (paths, canRead, protectedPaths) => {
        for (const path of paths) await instructions.discover(join(path, ".."), canRead, protectedPaths);
      },
      () => runtime.callTool("Read", { path: "packages/b/missing.ts" }),
    );
  };
  expect((await run(true)).kind).toBe("denied");
  expect(systemFieldFor(state, "one").system ?? "").not.toContain("B RULE");
  expect((await run(false)).kind).toBe("error");
  expect(systemFieldFor(state, "one").system ?? "").not.toContain("B RULE");
});

test("facade native sessions reload root guidance and retain it through proactive compaction", async () => {
  const f = await fixture();
  await f.put("AGENTS.md", "PERSISTENT ROOT RULE");
  const realBuild = _clientDeps.build;
  const systems: string[] = [];
  const model: ResolvedModel = {
    id: "test",
    provider: "openai",
    protocol: "openai-responses",
    pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    supportsTools: true,
    thinkingLevels: [],
  };
  try {
    _resetNativeClient();
    _clientDeps.build = async () =>
      withDerivedStream<Client>({
        model: async () => model,
        listModels: async () => [model],
        pricing: () => model.pricing,
        stream: async function* () {},
        validate: () => {},
        complete: async (_model, req) => {
          systems.push(req.system ?? "");
          return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
        },
      });
    const session = await createAgentSession({
      backend: nativeBackend({ model: "openai/test" }),
      sessionId: "facade",
      profile: "read",
      workdir: f.root,
      instructions: "HOST RULE",
      transcriptStore: f.store,
    });
    for await (const event of session.send("go")) {
      if (event.type === "turn_end") expect(event.status).toBe("completed");
    }
    expect(systems[0]).toContain("PERSISTENT ROOT RULE");
    expect(systems[0]).toContain("HOST RULE");
    await session.close();
    const adapter = new NativeSessionAdapter();
    const handle = await adapter.openSession("compact", {
      ...f.opts(),
      modelDef: { provider: "openai", model: "openai/test" },
      compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 },
    });
    await nativeSessionStateOf(adapter)
      .transcripts.get("compact")
      ?.store.save("compact", {
        savedAt: "now",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "a".repeat(20000) },
          { role: "user", content: "next" },
          { role: "assistant", content: "b".repeat(20000) },
        ],
      });
    let compacted = false;
    await adapter.sendTurn(handle, "continue", {
      interactionHandler: { onInteraction: async () => null },
      onTurnEvent: (event) => {
        if (event.type === "compaction") compacted = true;
      },
    });
    expect(compacted).toBe(true);
    expect(systems.at(-1)).toContain("PERSISTENT ROOT RULE");
    expect(f.docs.get("compact")?.instructionSources?.map((source) => source.path)).toEqual(["AGENTS.md"]);
    await adapter.closeSession(handle);
  } finally {
    _clientDeps.build = realBuild;
    _resetNativeClient();
  }
});

test("an import denied by its lexical alias cannot bypass exclusion through a permitted target", async () => {
  const f = await fixture();
  await f.put("AGENTS.md", "ROOT @docs/blocked.md");
  await f.put("docs/allowed.md", "ALIASED CONTENT");
  await symlink(join(f.root, "docs/allowed.md"), join(f.root, "docs/blocked.md"));
  const state = createNativeSessionState();
  await openNativeSession(state, "one", { ...f.opts(), instructionDenyPaths: ["docs/blocked.md"] });
  expect(systemFieldFor(state, "one").system).not.toContain("ALIASED CONTENT");
});

test("small model windows bound repository system context while retaining complete instruction provenance", async () => {
  const f = await fixture();
  await f.put("AGENTS.md", "ROOT " + "guidance ".repeat(2500));
  await f.put("packages/a/AGENTS.md", "PACKAGE A RULE");
  const realBuild = _clientDeps.build;
  const systems: string[] = [];
  const model: ResolvedModel = {
    id: "test",
    provider: "openai",
    protocol: "openai-responses",
    pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    supportsTools: true,
    thinkingLevels: [],
  };
  try {
    _resetNativeClient();
    _clientDeps.build = async () =>
      withDerivedStream<Client>({
        model: async () => model,
        listModels: async () => [model],
        pricing: () => model.pricing,
        stream: async function* () {},
        validate: () => {},
        complete: async (_model, req) => {
          systems.push(req.system ?? "");
          return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
        },
      });
    const adapter = new NativeSessionAdapter();
    const host = "HOST " + "h".repeat(495);
    const handle = await adapter.openSession("budget", {
      ...f.opts(["packages/a"]),
      modelDef: { provider: "openai", model: "openai/test" },
      systemPrompt: host,
    });
    await adapter.sendTurn(handle, "go", { interactionHandler: { onInteraction: async () => null } });
    expect(Buffer.byteLength(systems[0] ?? "", "utf8")).toBeLessThanOrEqual(2000);
    expect(systems[0]).toContain(host);
    expect(systems[0]).toContain("PACKAGE A RULE");
    expect(systems[0]).toContain("omitted");
    expect(f.docs.get("budget")?.instructionSources?.map((source) => source.path)).toEqual([
      "AGENTS.md",
      "packages/a/AGENTS.md",
    ]);
    await adapter.closeSession(handle);
  } finally {
    _clientDeps.build = realBuild;
    _resetNativeClient();
  }
});

test("protected lexical instruction aliases are refused before loader path resolution or reads", async () => {
  const f = await fixture();
  await f.put("AGENTS.md", "ROOT @docs/private.md");
  await f.put("docs/public.md", "PRIVATE ALIASED CONTENT");
  await symlink(join(f.root, "docs/public.md"), join(f.root, "docs/private.md"));
  const protectedPaths = {
    gitExcludePathspecs: [],
    gitIgnorePatterns: [],
    trustStoreFile: join(f.root, "docs/private.md"),
  };
  const pathSpy = spyOn(_repositoryInstructionDeps, "realpath");
  const readSpy = spyOn(_repositoryInstructionDeps, "readPrefix");
  try {
    const initial = new RepositoryInstructions(f.root, protectedPaths);
    await initial.discover(".");
    const dynamic = new RepositoryInstructions(f.root);
    await dynamic.discover(".", () => true, protectedPaths);
    expect(initial.render()).not.toContain("PRIVATE ALIASED CONTENT");
    expect(dynamic.render()).not.toContain("PRIVATE ALIASED CONTENT");
    expect(readSpy.mock.calls.some(([path]) => path.endsWith("docs/public.md"))).toBe(false);
    expect(pathSpy.mock.calls.some(([path]) => String(path).endsWith("docs/private.md"))).toBe(false);
  } finally {
    pathSpy.mockRestore();
    readSpy.mockRestore();
  }
});
