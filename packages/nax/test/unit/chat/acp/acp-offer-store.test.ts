import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import { _acpOfferStoreDeps, acpOffersPath, createAcpOfferStore } from "@/chat/acp/acp-offer-store";

const original = { ..._acpOfferStoreDeps };
let dir: string;
let path: string;
beforeEach(() => {
  dir = makeTempDir();
  path = join(dir, "nested", "acp-offers.json");
});
afterEach(() => {
  Object.assign(_acpOfferStoreDeps, original);
  cleanupTempDir(dir);
});
function fixture() {
  const logger = makeLogger();
  return { logger, store: createAcpOfferStore({ path, logger }) };
}
describe("acpOffersPath", () => {
  test("AC-1 joins the sessions directory", () => {
    expect(acpOffersPath("/s")).toBe(join("/s", "acp-offers.json"));
  });
});
describe("createAcpOfferStore", () => {
  test("AC-2 missing file is silent", async () => {
    const { store, logger } = fixture();
    expect(await store.load()).toEqual(new Map());
    expect(logger.warn).not.toHaveBeenCalled();
  });
  test("AC-3 reads the saved offer", async () => {
    await Bun.write(
      path,
      JSON.stringify({ version: 1, agents: { codex: { models: ["m1", "m2"], efforts: ["high"] } } }),
    );
    expect(await fixture().store.load()).toEqual(new Map([["codex", { models: ["m1", "m2"], efforts: ["high"] }]]));
  });
  test("AC-4 filters unknown agents and malformed lists", async () => {
    await Bun.write(
      path,
      JSON.stringify({
        version: 1,
        agents: {
          unknown: { models: ["x"] },
          claude: { models: "bad" },
          codex: { models: ["m", 1], efforts: [false, "high"] },
          cursor: { models: ["c"] },
        },
      }),
    );
    expect(await fixture().store.load()).toEqual(
      new Map([
        ["codex", { models: ["m"], efforts: ["high"] }],
        ["cursor", { models: ["c"], efforts: [] }],
      ]),
    );
  });
  test.each([
    ["AC-5 invalid JSON", "not json"],
    ["AC-6 unsupported version", '{"version":2,"agents":{}}'],
    ["AC-21 unreadable", "unreadable"],
  ])("%s warns once and AC-22 preserves content until save", async (_name, content) => {
    await Bun.write(path, content);
    if (content === "unreadable")
      _acpOfferStoreDeps.read = async () => {
        throw new Error("denied");
      };
    const { store, logger } = fixture();
    expect(await store.load()).toEqual(new Map());
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toBe("chat");
    expect(logger.warn.mock.calls[0]?.[1]).toContain(path);
    expect(await Bun.file(path).text()).toBe(content);
    await store.save(new Map([["cursor", { models: ["a"], efforts: [] }]]));
    expect(JSON.parse(await Bun.file(path).text()).agents.cursor.models).toEqual(["a"]);
  });
  test("AC-7 atomic round trip and AC-8 creates parent", async () => {
    expect(existsSync(dirname(path))).toBe(false);
    const rename = mock(original.rename);
    _acpOfferStoreDeps.rename = rename;
    const { store } = fixture();
    await store.save(new Map([["cursor", { models: ["a"], efforts: [] }]]));
    const temp = String(rename.mock.calls[0]?.[0]);
    expect(dirname(temp)).toBe(dirname(path));
    expect(temp.endsWith(".tmp")).toBe(true);
    expect(rename.mock.calls[0]?.[1]).toBe(path);
    expect(await store.load()).toEqual(new Map([["cursor", { models: ["a"], efforts: [] }]]));
  });
  test.each(["write", "rename"] as const)(
    "AC-9/23 cleans temp after %s failure; AC-24 preserves original error",
    async (effect) => {
      const error = new Error(effect);
      let temp = "";
      const write = original.write;
      _acpOfferStoreDeps.write = async (...args: Parameters<typeof write>) => {
        temp = String(args[0]);
        const result = await write(...args);
        if (effect === "write") throw error;
        return result;
      };
      if (effect === "rename")
        _acpOfferStoreDeps.rename = () => {
          throw error;
        };
      const { store } = fixture();
      await expect(store.save(new Map())).rejects.toBe(error);
      expect(temp).not.toBe("");
      expect(existsSync(temp)).toBe(false);
      _acpOfferStoreDeps.unlink = () => {
        throw new Error("cleanup");
      };
      await expect(store.save(new Map())).rejects.toBe(error);
    },
  );
});
