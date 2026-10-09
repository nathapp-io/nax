import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AuthInteraction, PromptCancelledError } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { type ModelPorts, mergeBalancedModel, NODE_CONFIG_WRITER, offerDefaultModel } from "#src/server/default-model";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-default-model-");
});
afterEach(() => cleanupTempDir(dir));

const path = () => join(dir, "config.json");
const readText: (p: string, e: "utf8") => Promise<string> = (p) => readFile(p, "utf8");
const MODELS: ModelPorts = {
  listModels: async () => [
    { id: "m-1", contextWindow: 200_000 },
    { id: "m-2", contextWindow: 1_000_000 },
  ],
};

interface Run {
  readonly out: string[];
  readonly prompts: string[];
}

async function offer(
  overrides: {
    isTTY?: boolean;
    pinned?: boolean;
    pick?: string | "cancel";
    models?: ModelPorts;
    /** Runs while the user is picking (after the file was read, before the write). */
    duringPick?: () => Promise<void>;
  } = {},
): Promise<Run> {
  const out: string[] = [];
  const prompts: string[] = [];
  const interaction: AuthInteraction = {
    notify: () => undefined,
    prompt: async (prompt) => {
      await overrides.duringPick?.();
      prompts.push(prompt.type === "select" ? prompt.options.map((o) => o.id).join(",") : prompt.type);
      if (overrides.pick === "cancel") throw new PromptCancelledError();
      return overrides.pick ?? "model:m-2";
    },
  };
  await offerDefaultModel({
    provider: "acme",
    configDir: dir,
    isTTY: overrides.isTTY ?? true,
    pinned: overrides.pinned ?? false,
    interaction,
    out: (line) => out.push(line),
    models: overrides.models ?? MODELS,
    readFile: readText,
    write: NODE_CONFIG_WRITER,
  });
  return { out, prompts };
}

describe("mergeBalancedModel", () => {
  test("creates the models.native.balanced path in an empty document", () => {
    const merged = mergeBalancedModel(undefined, "acme/m-1");
    expect(merged.ok && JSON.parse(merged.text)).toEqual({ models: { native: { balanced: "acme/m-1" } } });
  });

  test("keeps every other key, including sibling tiers", () => {
    const existing = JSON.stringify({
      auth: { source: "file" },
      models: { native: { fast: "acme/f" }, claude: { fast: "haiku" } },
    });
    const merged = mergeBalancedModel(existing, "acme/m-1");
    expect(merged.ok && JSON.parse(merged.text)).toEqual({
      auth: { source: "file" },
      models: { native: { fast: "acme/f", balanced: "acme/m-1" }, claude: { fast: "haiku" } },
    });
  });

  test("refuses malformed JSON and non-object shapes", () => {
    expect(mergeBalancedModel("{ nope", "a/b").ok).toBe(false);
    expect(mergeBalancedModel("[]", "a/b").ok).toBe(false);
    expect(mergeBalancedModel('{"models": 3}', "a/b").ok).toBe(false);
    expect(mergeBalancedModel('{"models": {"native": "x"}}', "a/b").ok).toBe(false);
  });
});

describe("offerDefaultModel", () => {
  test("the user picks a model: it is written as models.native.balanced in a new 0600 file", async () => {
    const run = await offer();
    expect(run.prompts).toEqual(["model:m-1,model:m-2,skip"]);
    expect(JSON.parse(await readFile(path(), "utf8"))).toEqual({ models: { native: { balanced: "acme/m-2" } } });
    expect((await stat(path())).mode & 0o777).toBe(0o600);
    expect(run.out.join("\n")).toContain("acme/m-2");
  });

  test("merges into an existing config.json without clobbering other keys", async () => {
    await writeFile(path(), JSON.stringify({ auth: { source: "file" }, agentServer: { defaultMode: "read" } }));
    await offer({ pick: "model:m-1" });
    expect(JSON.parse(await readFile(path(), "utf8"))).toEqual({
      auth: { source: "file" },
      agentServer: { defaultMode: "read" },
      models: { native: { balanced: "acme/m-1" } },
    });
  });

  test("creates a missing config directory", async () => {
    dir = join(dir, "nested", "cfg");
    await offer();
    expect((await readFile(path(), "utf8")).includes("acme/m-2")).toBe(true);
  });

  test("never touches the credentials file", async () => {
    const credentials = join(dir, "credentials.json");
    await writeFile(credentials, '{"k":"v"}');
    await offer();
    expect(await readFile(credentials, "utf8")).toBe('{"k":"v"}');
  });

  test("a configured balanced model, or a pinned one (flag or env), is left alone and nothing is asked", async () => {
    await writeFile(path(), JSON.stringify({ models: { native: { balanced: "acme/keep" } } }));
    expect((await offer()).prompts).toEqual([]);
    expect(JSON.parse(await readFile(path(), "utf8")).models.native.balanced).toBe("acme/keep");
    await mkdir(join(dir, "other"));
    dir = join(dir, "other");
    const pinned = await offer({ pinned: true });
    expect(pinned.prompts).toEqual([]);
    await expect(stat(path())).rejects.toThrow();
  });

  test("no TTY: nothing is written or asked, one instruction line is printed", async () => {
    const run = await offer({ isTTY: false });
    expect(run.prompts).toEqual([]);
    expect(run.out).toHaveLength(1);
    expect(run.out[0]).toContain("models.native.balanced");
    expect(run.out[0]).toContain("acme/");
    await expect(stat(path())).rejects.toThrow();
  });

  test("a malformed existing config.json is not overwritten; the instruction is printed", async () => {
    await writeFile(path(), "{ not json");
    const run = await offer();
    expect(await readFile(path(), "utf8")).toBe("{ not json");
    expect(run.prompts).toEqual([]);
    expect(run.out.join("\n")).toContain("models.native.balanced");
  });

  test("skip, a cancelled pick, an empty catalog and a failing catalog all write nothing", async () => {
    for (const run of [
      await offer({ pick: "skip" }),
      await offer({ pick: "cancel" }),
      await offer({ models: { listModels: async () => [] } }),
      await offer({ models: { listModels: async () => Promise.reject(new Error("catalog")) } }),
    ]) {
      expect(run.out.join("\n")).toContain("models.native.balanced");
    }
    await expect(stat(path())).rejects.toThrow();
  });
});

describe("the config writer", () => {
  const leftovers = async () => (await readdir(dir)).filter((name) => name.endsWith(".tmp"));

  test("a new file is 0600 and a created directory 0700, with no temp file left", async () => {
    dir = join(dir, "fresh");
    await offer();
    expect((await stat(path())).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await leftovers()).toEqual([]);
  });

  test("an existing 0644 file keeps its mode, and other keys keep their order", async () => {
    await writeFile(path(), '{"zeta":1,"alpha":{"b":2,"a":1}}');
    await chmod(path(), 0o644);
    await offer();
    expect((await stat(path())).mode & 0o777).toBe(0o644);
    const text = await readFile(path(), "utf8");
    expect(Object.keys(JSON.parse(text))).toEqual(["zeta", "alpha", "models"]);
    expect(Object.keys(JSON.parse(text).alpha)).toEqual(["b", "a"]);
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    expect(await leftovers()).toEqual([]);
  });

  test("a symlinked config.json updates its target and stays a symlink", async () => {
    const real = join(dir, "real");
    await mkdir(real);
    await writeFile(join(real, "shared.json"), '{"keep":true}');
    await symlink(join(real, "shared.json"), path());
    await offer();
    expect((await lstat(path())).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(join(real, "shared.json"), "utf8"))).toEqual({
      keep: true,
      models: { native: { balanced: "acme/m-2" } },
    });
    expect(await leftovers()).toEqual([]);
    expect(await readdir(real)).toEqual(["shared.json"]);
  });

  test("a file changed between the read and the write is left alone, with the instruction", async () => {
    await writeFile(path(), '{"a":1}');
    const run = await offer({ duringPick: () => writeFile(path(), '{"a":2}') });
    expect(await readFile(path(), "utf8")).toBe('{"a":2}');
    expect(run.out.join("\n")).toContain("changed while picking; left unchanged");
    expect(run.out.join("\n")).toContain("models.native.balanced");
    expect(await leftovers()).toEqual([]);
  });

  test("a file created between the read and the write is also left alone", async () => {
    const run = await offer({ duringPick: () => writeFile(path(), "{}") });
    expect(await readFile(path(), "utf8")).toBe("{}");
    expect(run.out.join("\n")).toContain("changed while picking");
  });

  test("a failed write removes its temp file and reports the error", async () => {
    await writeFile(path(), "{}");
    await rm(path());
    await mkdir(path()); // config.json is a directory: the rename cannot replace it
    await expect(NODE_CONFIG_WRITER(path(), "{}")).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });
});

describe("a catalog failure", () => {
  test("is named in one redacted line before the manual instruction", async () => {
    const run = await offer({
      models: {
        listModels: async () => Promise.reject(new Error("catalog down sk-ant-api03-abcdefghijklmnopqrstuvwxyz")),
      },
    });
    expect(run.out).toHaveLength(2);
    expect(run.out[0]).toContain("Could not list acme models: catalog down");
    expect(run.out[0]).not.toContain("abcdefghijklmnop");
    expect(run.out[1]).toContain("models.native.balanced");
  });
});
