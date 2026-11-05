/**
 * US-010 — `nax memory link`: point a repository at the koda project that holds its memories.
 *
 * Every case drives `memoryLinkCommand` (or the program `registerMemoryCommand` builds) with the
 * seams a link acts through stubbed — `_memoryAdminDeps`, `_kodaClientDeps.fetch` and
 * `deps.createMemoryHost` — through the harness in `@test/helpers`. What is pinned here is the
 * file that lands on disk, the line that reaches each output channel, the exit code, and, for
 * every refusal, that nothing was written.
 *
 * The mirror transition a forced relink makes — the record it leaves, the discard, the rollback —
 * is `memory-admin-link-relink.test.ts`; two cases here read a real directory instead: the config
 * a link creates where there is none (whose parent directory must be created for it), and the
 * seam's own members, which US-011's `reset` builds on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  answerProbe,
  assertDefined,
  at,
  EXPECTED_NEW_CONFIG,
  jsonAnswer,
  KODA_HEADERS,
  LINK_CONFIG_PATH,
  LINK_REPO,
  LINK_SLUG,
  LINK_TMP_PATH,
  linkConfigPathIn,
  makeLinkHarness,
  makeNaxConfig,
  OTHER_LINKED,
  OTHER_PROJECT,
  probeCalls,
  probeUrlFor,
  RAW_PROJECT,
  realAdminDeps,
  restoreSeams,
  runLink,
  saveSeams,
  statefulFs,
  withTempDir,
  writtenConfig,
  writtenConfigText,
} from "@test/helpers";
import { Command } from "commander";
import { _memoryAdminDeps, registerMemoryCommand } from "@/cli";
import { restoreProjectConfig } from "@/cli/memory-admin-config";

/** The `direct` envelope the probe answers, and the `proposal` one a case varies to. */
function directProbe(): void {
  answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));
}

beforeEach(() => {
  saveSeams();
});

afterEach(() => {
  restoreSeams();
});

// ─── the write ───────────────────────────────────────────────────────────────

describe("nax memory link — the config it writes", () => {
  test("AC-1: links the repo to the project and returns 0", async () => {
    const h = makeLinkHarness();
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(0);
    const written = writtenConfig(h);
    expect(at(written, "memory", "provider")).toBe("koda");
    expect(at(written, "memory", "koda", "project")).toBe(LINK_SLUG);
    expect(h.err).toEqual([]);
  });

  test("AC-2: keeps every other key of the raw project config, other memory keys included", async () => {
    const h = makeLinkHarness({ projectConfig: RAW_PROJECT });
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(0);
    const written = writtenConfig(h);
    expect(at(written, "name")).toBe("rs-app");
    expect(at(written, "quality", "commands", "test")).toBe("bun test");
    expect(at(written, "memory", "enabled")).toBe(false);
    expect(at(written, "memory", "indexBytes")).toBe(4096);
    expect(at(written, "memory", "provider")).toBe("koda");
    expect(at(written, "memory", "koda", "project")).toBe(LINK_SLUG);
  });

  test("AC-3: the global url and headers do not reach the project config", async () => {
    const h = makeLinkHarness();
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(0);
    const written = writtenConfig(h);
    expect(at(written, "memory", "koda", "url")).toBeUndefined();
    expect(at(written, "memory", "koda", "headers")).toBeUndefined();
  });

  test("AC-4: writes the config, and its directory, when the file does not exist", async () => {
    await withTempDir(async (dir) => {
      const h = makeLinkHarness({
        repo: dir,
        fs: { writeText: realAdminDeps.writeText, rename: realAdminDeps.rename },
      });
      directProbe();

      expect(await runLink(h, LINK_SLUG)).toBe(0);
      const text = await Bun.file(linkConfigPathIn(dir)).text();
      expect(at(JSON.parse(text), "memory", "koda", "project")).toBe(LINK_SLUG);
    });
  });

  test("AC-5: the written text is two-space JSON followed by one newline", async () => {
    const h = makeLinkHarness();
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(0);
    expect(h.fs.writes.map((write) => write.path)).toEqual([LINK_TMP_PATH]);
    expect(writtenConfigText(h)).toBe(EXPECTED_NEW_CONFIG);
  });

  test("AC-6: it writes config.json.tmp and renames it onto config.json", async () => {
    const h = makeLinkHarness();
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(0);
    expect(h.fs.renames).toEqual([{ from: LINK_TMP_PATH, to: LINK_CONFIG_PATH }]);
    expect(h.fs.events).toEqual(["write", "rename"]);
  });
});

// ─── the probe and the output ────────────────────────────────────────────────

describe("nax memory link — the probe and the line", () => {
  test("AC-7: it probes the project's write mode with the global config's headers", async () => {
    const h = makeLinkHarness();
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(0);
    expect(probeCalls()).toHaveLength(1);
    expect(probeCalls()[0]?.url).toBe(probeUrlFor());
    expect(probeCalls()[0]?.init.method).toBe("GET");
    expect(probeCalls()[0]?.init.headers).toMatchObject({ authorization: KODA_HEADERS.Authorization });
  });

  test("AC-8: it prints the link line", async () => {
    const h = makeLinkHarness();
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(0);
    expect(h.out).toEqual([`linked ${LINK_REPO} to koda project ${LINK_SLUG} (write mode: direct)`]);
  });

  test("AC-9: --json prints one document naming the project, the mode and the path", async () => {
    const h = makeLinkHarness();
    directProbe();

    expect(await runLink(h, LINK_SLUG, { json: true })).toBe(0);
    expect(h.out).toEqual([JSON.stringify({ project: LINK_SLUG, writeMode: "direct", configPath: LINK_CONFIG_PATH })]);
  });

  test("both output forms report the mode the probe answered, not a fixed one", async () => {
    const human = makeLinkHarness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "proposal" } }));
    expect(await runLink(human, LINK_SLUG)).toBe(0);
    expect(human.out).toEqual([`linked ${LINK_REPO} to koda project ${LINK_SLUG} (write mode: proposal)`]);

    const machine = makeLinkHarness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "proposal" } }));
    expect(await runLink(machine, LINK_SLUG, { json: true })).toBe(0);
    expect(machine.out).toEqual([
      JSON.stringify({ project: LINK_SLUG, writeMode: "proposal", configPath: LINK_CONFIG_PATH }),
    ]);
  });
});

// ─── the refusals ────────────────────────────────────────────────────────────

describe("nax memory link — what it refuses", () => {
  test("AC-10: a slug that is not a koda project slug", async () => {
    const h = makeLinkHarness();

    expect(await runLink(h, "RS stock")).toBe(1);
    expect(h.err).toEqual(['[memory] "RS stock" is not a koda project slug']);
    expect(h.fs.writes).toEqual([]);
    expect(h.fs.reads).toEqual([]);
    expect(probeCalls()).toEqual([]);
  });

  test("AC-11: a loaded config without memory.koda.url", async () => {
    const h = makeLinkHarness({ loadConfig: async () => makeNaxConfig({ memory: { enabled: true } }) });

    expect(await runLink(h, LINK_SLUG)).toBe(1);
    expect(h.err).toEqual(["[memory] memory.koda.url is not set in ~/.nax/config.json"]);
    expect(h.fs.writes).toEqual([]);
    expect(probeCalls()).toEqual([]);
  });

  test("AC-12: a probe answered 403", async () => {
    const h = makeLinkHarness();
    answerProbe(() => jsonAnswer({ ret: 403, message: "forbidden" }, 403));

    expect(await runLink(h, LINK_SLUG)).toBe(1);
    expect(h.err[0]?.startsWith(`[memory] koda project "${LINK_SLUG}" is not reachable:`)).toBe(true);
    expect(h.err[0]).toContain("403");
    expect(h.fs.writes).toEqual([]);
  });

  test("AC-13: a probe answered with a write mode koda does not write with", async () => {
    const h = makeLinkHarness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "other" } }));

    expect(await runLink(h, LINK_SLUG)).toBe(1);
    expect(h.err[0]?.startsWith(`[memory] koda project "${LINK_SLUG}" is not reachable:`)).toBe(true);
    expect(h.fs.writes).toEqual([]);
  });

  test("AC-14: a project config that is not JSON, read before the config is loaded", async () => {
    const h = makeLinkHarness({
      projectConfig: "{ broken",
      loadConfig: async () => {
        throw new Error("the loader must not be reached");
      },
    });

    expect(await runLink(h, LINK_SLUG)).toBe(1);
    expect(h.err).toEqual([`[memory] cannot link: ${LINK_CONFIG_PATH} is not valid JSON`]);
    expect(h.fs.writes).toEqual([]);
    expect(probeCalls()).toEqual([]);
  });

  test("AC-15: a project config that is JSON but not an object", async () => {
    const h = makeLinkHarness({ projectConfig: "[1]" });

    expect(await runLink(h, LINK_SLUG)).toBe(1);
    expect(h.err).toEqual([`[memory] cannot link: ${LINK_CONFIG_PATH} is not a JSON object`]);
    expect(h.fs.writes).toEqual([]);
  });

  test("AC-16: another koda project already linked, without --force", async () => {
    const h = makeLinkHarness({ projectConfig: OTHER_LINKED });

    expect(await runLink(h, LINK_SLUG)).toBe(1);
    expect(h.err).toEqual([
      `[memory] already linked to koda project "${OTHER_PROJECT}"; pass --force to relink (the project mirror is rebuilt)`,
    ]);
    expect(h.fs.writes).toEqual([]);
    expect(h.hostCalls).toEqual([]);
    expect(probeCalls()).toEqual([]);
  });

  test("AC-17: a forced relink while writes are still undelivered", async () => {
    const h = makeLinkHarness({ projectConfig: OTHER_LINKED, counts: { queued: 1, rejected: 0 } });

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
    expect(h.err).toEqual([
      "[memory] 1 writes are not delivered (1 queued, 0 rejected); run nax memory sync before relinking",
    ]);
    expect(h.fs.writes).toEqual([]);
    expect(h.fs.removed).toEqual([]);
    expect(probeCalls()).toEqual([]);
  });

  test("AC-21: a probe that throws", async () => {
    const h = makeLinkHarness();
    answerProbe(() => {
      throw new Error("socket closed");
    });

    expect(await runLink(h, LINK_SLUG)).toBe(1);
    const line = h.err[0] ?? "";
    expect(line.startsWith(`[memory] koda project "${LINK_SLUG}" is not reachable:`)).toBe(true);
    expect(line).toContain("socket closed");
    expect(h.fs.writes).toEqual([]);
  });

  test("AC-22: a merged config that does not load", async () => {
    const h = makeLinkHarness({
      loadConfig: async () => {
        throw new Error("Invalid configuration:\nmemory.koda.url: needed");
      },
    });

    expect(await runLink(h, LINK_SLUG)).toBe(1);
    expect(h.err).toEqual(["Error: Invalid configuration:\nmemory.koda.url: needed"]);
    expect(h.fs.writes).toEqual([]);
  });
});

// ─── registration ────────────────────────────────────────────────────────────

describe("registerMemoryCommand — link", () => {
  test("AC-20: nax memory link rs-stock reaches the command through the program", async () => {
    const h = makeLinkHarness();
    directProbe();
    const program = new Command();
    registerMemoryCommand(program, h.deps);

    await program.parseAsync(["node", "nax", "memory", "link", LINK_SLUG, "--dir", LINK_REPO]);

    expect(probeCalls().map((call) => call.url)).toEqual([probeUrlFor()]);
    expect(at(writtenConfig(h), "memory", "koda", "project")).toBe(LINK_SLUG);
    expect(h.codes).toEqual([0]);
  });

  test("AC-23: link is registered after approve", () => {
    const program = new Command();
    registerMemoryCommand(program, makeLinkHarness().deps);
    const memory = program.commands.find((command) => command.name() === "memory");
    assertDefined(memory, "the memory command");

    expect(memory.commands.map((command) => command.name()).slice(0, 8)).toEqual([
      "status",
      "list",
      "show",
      "sync",
      "save",
      "forget",
      "approve",
      "link",
    ]);
  });
});

// ─── the filesystem seam ─────────────────────────────────────────────────────

describe("_memoryAdminDeps", () => {
  test("readText answers null for a file that does not exist", async () => {
    await withTempDir(async (dir) => {
      expect(await realAdminDeps.readText(join(dir, "absent.json"))).toBeNull();
    });
  });

  test("writeText creates the parent directories, and rename puts the text in place", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, ".nax", "config.json");
      await realAdminDeps.writeText(`${target}.tmp`, "{}\n");
      await realAdminDeps.rename(`${target}.tmp`, target);

      expect(await Bun.file(target).text()).toBe("{}\n");
      expect(await Bun.file(`${target}.tmp`).exists()).toBe(false);
    });
  });

  test("listDir answers [] for an absent directory and its entry names otherwise", async () => {
    await withTempDir(async (dir) => {
      expect(await realAdminDeps.listDir(join(dir, "absent"))).toEqual([]);
      await realAdminDeps.writeText(join(dir, "mirror", "notes.json"), "[]");
      expect(await realAdminDeps.listDir(join(dir, "mirror"))).toEqual(["notes.json"]);
    });
  });

  test("removePath removes a tree, and a missing path is not an error", async () => {
    await withTempDir(async (dir) => {
      await realAdminDeps.writeText(join(dir, "mirror", "notes.json"), "[]");
      await realAdminDeps.removePath(join(dir, "mirror"));
      expect(await Bun.file(join(dir, "mirror", "notes.json")).exists()).toBe(false);
      await realAdminDeps.removePath(join(dir, "mirror"));
    });
  });
});

// ─── the project config document ────────────────────────────────────────────

describe("restoreProjectConfig", () => {
  test("a config the link created is removed, not emptied", async () => {
    const store = statefulFs(null);
    Object.assign(_memoryAdminDeps, store.deps);
    store.files.set(LINK_CONFIG_PATH, '{ "memory": { "provider": "koda" } }\n');

    await restoreProjectConfig(LINK_CONFIG_PATH, null);

    expect(store.files.has(LINK_CONFIG_PATH)).toBe(false);
    expect(store.removed).toEqual([LINK_CONFIG_PATH]);
  });

  test("a config that existed is put back byte for byte", async () => {
    const store = statefulFs(null);
    Object.assign(_memoryAdminDeps, store.deps);
    store.files.set(LINK_CONFIG_PATH, '{"memory":{"koda":{"project":"other"}}}');

    await restoreProjectConfig(LINK_CONFIG_PATH, OTHER_LINKED);

    expect(store.files.get(LINK_CONFIG_PATH)).toBe(OTHER_LINKED);
    expect(store.removed).toEqual([]);
  });
});
