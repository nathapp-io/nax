/**
 * US-006: the recent-model list and its store.
 *
 * The list is the five most recently used provider-qualified models, newest first, unique by
 * base — `provider/model` without the effort suffix — so the same model name offered by two
 * providers is two entries. Recording a base already listed replaces its entry and moves it to
 * the front, which is how a remembered effort follows the model it was used at.
 *
 * The store mirrors `createAcpOfferStore`: versioned JSON beside the sessions directory, an
 * atomic temp-and-rename write, and a load that answers empty rather than throwing.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import {
  _recentModelStoreDeps,
  createRecentModelStore,
  MAX_RECENT_MODELS,
  RECENT_MODELS_FILE,
  recentModelsPath,
  recordRecentModel,
} from "@/chat/recent-models";

const original = { ..._recentModelStoreDeps };
let dir: string;
let path: string;
beforeEach(() => {
  dir = makeTempDir();
  path = join(dir, "nested", RECENT_MODELS_FILE);
});
afterEach(() => {
  Object.assign(_recentModelStoreDeps, original);
  cleanupTempDir(dir);
});
function fixture() {
  const logger = makeLogger();
  return { logger, store: createRecentModelStore({ path, logger }) };
}

describe("recordRecentModel", () => {
  test("AC-1 an empty list starts with the model as it was used, effort included", () => {
    expect(recordRecentModel([], "openai/gpt-6[high]")).toEqual(["openai/gpt-6[high]"]);
  });

  test("AC-2 a listed base is replaced in place and moved to the front with the new effort", () => {
    expect(recordRecentModel(["a/x[low]", "b/y"], "a/x[high]")).toEqual(["a/x[high]", "b/y"]);
  });

  test("AC-3 two providers offering the same model name are two entries", () => {
    const recents = recordRecentModel(["openai/gpt-6.1-sol"], "openai-codex/gpt-6.1-sol");
    expect(recents).toEqual(["openai-codex/gpt-6.1-sol", "openai/gpt-6.1-sol"]);
  });

  test("AC-4 a sixth distinct base keeps MAX_RECENT_MODELS entries and drops the oldest", () => {
    const five = ["a/1", "a/2", "a/3", "a/4", "a/5"];
    const recents = recordRecentModel(five, "a/6");
    expect(MAX_RECENT_MODELS).toBe(5);
    expect(recents).toEqual(["a/6", "a/1", "a/2", "a/3", "a/4"]);
  });

  test("re-recording the front entry keeps the list and its order", () => {
    expect(recordRecentModel(["a/x[high]", "b/y"], "a/x[high]")).toEqual(["a/x[high]", "b/y"]);
  });

  test("the effort suffix is what makes a base equal, not the whole string", () => {
    expect(recordRecentModel(["a/x"], "a/x[low]")).toEqual(["a/x[low]"]);
  });
});

describe("recentModelsPath", () => {
  test("joins the sessions directory", () => {
    expect(recentModelsPath("/s")).toBe(join("/s", "chat-recent-models.json"));
  });
});

describe("createRecentModelStore", () => {
  test("AC-5 save then load round-trips, and AC-6 the file is version 1", async () => {
    const { store } = fixture();
    await store.save(["a/x[high]"]);
    expect(await store.load()).toEqual(["a/x[high]"]);
    const written = JSON.parse(await Bun.file(path).text());
    expect(written.version).toBe(1);
    expect(written.models).toEqual(["a/x[high]"]);
  });

  test("AC-7 a missing file is empty and silent", async () => {
    const { store, logger } = fixture();
    expect(await store.load()).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("AC-8 an unsupported version is empty and warns once", async () => {
    await Bun.write(path, JSON.stringify({ version: 2, models: ["a/x[high]"] }));
    const { store, logger } = fixture();
    expect(await store.load()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toBe("chat");
    expect(logger.warn.mock.calls[0]?.[1]).toContain(path);
  });

  test("AC-29 an unreadable file is empty and warns once", async () => {
    _recentModelStoreDeps.read = async () => {
      throw new Error("denied");
    };
    const { store, logger } = fixture();
    expect(await store.load()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toBe("chat");
  });

  test("a stored list is trimmed to the distinct bases it holds, newest first", async () => {
    await Bun.write(path, JSON.stringify({ version: 1, models: ["a/x[low]", "a/x[high]", "b/y", 7] }));
    expect(await fixture().store.load()).toEqual(["a/x[low]", "b/y"]);
  });

  test("save writes atomically through a temp file beside the store", async () => {
    expect(existsSync(join(dir, "nested"))).toBe(false);
    const rename = mock(original.rename);
    _recentModelStoreDeps.rename = rename;
    const { store } = fixture();
    await store.save(["a/x"]);
    const temp = String(rename.mock.calls[0]?.[0]);
    expect(temp.endsWith(".tmp")).toBe(true);
    expect(dirname(temp)).toBe(dirname(path));
    expect(rename.mock.calls[0]?.[1]).toBe(path);
  });

  test("AC-9 a save whose write throws leaves no .tmp file beside the store", async () => {
    const failure = new Error("disk full");
    const write = original.write;
    _recentModelStoreDeps.write = async (...args: Parameters<typeof write>) => {
      await write(...args);
      throw failure;
    };
    const { store } = fixture();
    await expect(store.save(["a/x"])).rejects.toBe(failure);
    expect(readdirSync(join(dir, "nested")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a failed rename also cleans its temp file and rethrows the original error", async () => {
    const failure = new Error("rename failed");
    _recentModelStoreDeps.rename = () => {
      throw failure;
    };
    const { store } = fixture();
    await expect(store.save(["a/x"])).rejects.toBe(failure);
    expect(readdirSync(join(dir, "nested")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
