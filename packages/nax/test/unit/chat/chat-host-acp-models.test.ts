/**
 * US-008 AC-3..AC-11: the chat host composes the ACP catalog into `models`,
 * `effortLevels` and `modelNote`; a host without a catalog keeps today's behavior.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createSessionStorage } from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { AcpCatalog } from "@/chat/acp";
import { EFFORT_LEVELS, type EffortLevel } from "@/chat/chat-effort";
import { type ChatHost, createChatHost } from "@/chat/chat-host";
import { tierModels } from "@/chat/chat-models";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const NATIVE = "openai/gpt-6";
const CODEX_EFFORTS: readonly EffortLevel[] = ["default", "high"];

let dir: string;
let hosts: ChatHost[];

beforeEach(() => {
  dir = makeTempDir("chat-host-acp-models-");
  hosts = [];
});
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.close()));
  cleanupTempDir(dir);
});

/** A catalog whose answers are scripted; unset members answer nothing. */
function stubCatalog(overrides: Partial<AcpCatalog> = {}): AcpCatalog {
  return {
    load: async () => {},
    rows: () => [],
    effortLevels: () => ["default"],
    installed: () => true,
    unavailable: () => undefined,
    opened: () => {},
    failed: () => {},
    ...overrides,
  };
}

function makeHost(input: { acp?: AcpCatalog; effortLevels?: ReadonlyMap<string, readonly EffortLevel[]> }): ChatHost {
  const host = createChatHost({
    models: [NATIVE],
    ...(input.acp ? { acp: input.acp } : {}),
    ...(input.effortLevels ? { effortLevels: input.effortLevels } : {}),
    config: makeNaxConfig(),
    cwd: dir,
    repoRoot: dir,
    chain: null,
    storage: createSessionStorage({
      dir: join(dir, "sessions"),
      pid: process.pid,
      now: () => NOW,
      logger: makeLogger(),
      isAlive: () => true,
    }),
    now: () => NOW,
    logger: makeLogger(),
  });
  hosts.push(host);
  return host;
}

describe("chat host ACP models", () => {
  test("AC-3 models lists the deps' models followed by the catalog rows", () => {
    const host = makeHost({ acp: stubCatalog({ rows: () => ["acp:claude"] }) });
    expect(host.models).toEqual([NATIVE, "acp:claude"]);
  });

  test("AC-4 a host without a catalog lists only the deps' models", () => {
    expect(makeHost({}).models).toEqual([NATIVE]);
  });

  test("AC-5 models re-reads the catalog rows on every read", () => {
    let rows: readonly string[] = ["acp:claude"];
    const host = makeHost({ acp: stubCatalog({ rows: () => rows }) });
    expect(host.models).toEqual([NATIVE, "acp:claude"]);
    rows = ["acp:claude", "acp:codex/gpt-5.5"];
    expect(host.models).toEqual([NATIVE, "acp:claude", "acp:codex/gpt-5.5"]);
  });

  test("models falls back to the tier models when the deps list none", () => {
    const config = makeNaxConfig({ models: { native: { balanced: "openai/gpt-6" } } });
    const host = createChatHost({
      config,
      cwd: dir,
      repoRoot: dir,
      chain: null,
      storage: createSessionStorage({
        dir: join(dir, "sessions"),
        pid: process.pid,
        now: () => NOW,
        logger: makeLogger(),
        isAlive: () => true,
      }),
      now: () => NOW,
      logger: makeLogger(),
      acp: stubCatalog({ rows: () => ["acp:claude"] }),
    });
    hosts.push(host);
    expect(tierModels(config)).toContain("openai/gpt-6");
    expect(host.models).toEqual([...tierModels(config), "acp:claude"]);
  });
});

describe("chat host ACP effort levels", () => {
  test("AC-6 an ACP model takes the catalog's effort levels", () => {
    const host = makeHost({
      acp: stubCatalog({ effortLevels: (model) => (model === "acp:codex" ? CODEX_EFFORTS : []) }),
    });
    expect(host.effortLevels?.("acp:codex")).toEqual(CODEX_EFFORTS);
  });

  test("AC-7 an ACP model on a host without a catalog offers only default", () => {
    expect(makeHost({}).effortLevels?.("acp:codex")).toEqual(["default"]);
  });

  test("AC-8 a native model keeps the deps' map, else every level, with a catalog present", () => {
    const mapped: readonly EffortLevel[] = ["default", "low"];
    const acp = stubCatalog({ effortLevels: () => CODEX_EFFORTS });
    const withMap = makeHost({ acp, effortLevels: new Map([[NATIVE, mapped]]) });
    expect(withMap.effortLevels?.(NATIVE)).toEqual(mapped);
    expect(makeHost({ acp }).effortLevels?.(NATIVE)).toBe(EFFORT_LEVELS);
  });
});

describe("chat host ACP model note", () => {
  test("AC-9 returns the catalog's unavailable reason for the model", () => {
    const asked: string[] = [];
    const host = makeHost({
      acp: stubCatalog({
        unavailable: (model) => {
          asked.push(model);
          return "not logged in";
        },
      }),
    });
    expect(host.modelNote?.("acp:cursor")).toBe("not logged in");
    expect(asked).toEqual(["acp:cursor"]);
  });

  test("AC-10 returns undefined on a host without a catalog", () => {
    expect(makeHost({}).modelNote?.("acp:cursor")).toBeUndefined();
  });

  test("AC-11 returns 'not installed' when the catalog reports the agent as not installed", () => {
    const host = makeHost({
      acp: stubCatalog({ unavailable: (model) => (model === "acp:cursor" ? "not installed" : undefined) }),
    });
    expect(host.modelNote?.("acp:cursor")).toBe("not installed");
  });
});
