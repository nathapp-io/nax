import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { pickSelector } from "@/config/selector";

describe("ConfigSelector", () => {
  describe("pickSelector", () => {
    test("select() picks named keys from config", () => {
      const sel = pickSelector("test", "routing");
      const cfg = makeNaxConfig({ routing: { strategy: "keyword" } });
      expect(sel.select(cfg)).toMatchObject({
        routing: { strategy: "keyword" },
      });
    });

    test("name is set", () => {
      const sel = pickSelector("my-sel", "routing");
      expect(sel.name).toBe("my-sel");
    });

    test("picks multiple keys", () => {
      const sel = pickSelector("multi", "routing", "execution");
      const cfg = makeNaxConfig({
        routing: { strategy: "keyword" },
        execution: { costLimit: 3 },
      });
      const result = sel.select(cfg);
      expect(result).toHaveProperty("routing");
      expect(result).toHaveProperty("execution");
    });

    test("omits keys it does not pick, even when the config carries them", () => {
      const sel = pickSelector("single", "routing");
      const cfg = makeNaxConfig({ routing: { strategy: "keyword" }, execution: { costLimit: 3 } });
      expect(Object.keys(sel.select(cfg))).toEqual(["routing"]);
    });
  });
});
