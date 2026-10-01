import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { pickSelector, reshapeSelector } from "@/config/selector";
import type { NaxConfig } from "@/config/types";

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
        execution: { maxIterations: 3 },
      });
      const result = sel.select(cfg);
      expect(result).toHaveProperty("routing");
      expect(result).toHaveProperty("execution");
    });
  });

  describe("reshapeSelector", () => {
    test("applies transform fn", () => {
      const sel = reshapeSelector("flat", (c: NaxConfig) => ({
        strategy: c.routing.strategy,
      }));
      const cfg = makeNaxConfig({ routing: { strategy: "llm" } });
      expect(sel.select(cfg).strategy).toBe("llm");
    });

    test("name is set", () => {
      const sel = reshapeSelector("flat", () => ({}));
      expect(sel.name).toBe("flat");
    });

    test("returns arbitrary shape", () => {
      const sel = reshapeSelector("custom", (c: NaxConfig) => ({
        isParallel: c.review.adversarial?.parallel,
        agentName: "test",
      }));
      const cfg = makeNaxConfig({ review: { adversarial: { parallel: true } } });
      const result = sel.select(cfg);
      expect(result.isParallel).toBe(true);
      expect(result.agentName).toBe("test");
    });
  });
});
