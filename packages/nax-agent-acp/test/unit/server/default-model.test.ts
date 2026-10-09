import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
  overrides: { isTTY?: boolean; pinned?: boolean; pick?: string | "cancel"; models?: ModelPorts } = {},
): Promise<Run> {
  const out: string[] = [];
  const prompts: string[] = [];
  const interaction: AuthInteraction = {
    notify: () => undefined,
    prompt: async (prompt) => {
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
