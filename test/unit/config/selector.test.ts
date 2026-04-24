import { describe, test, expect } from "bun:test";
import { pickSelector, reshapeSelector } from "../../../src/config/selector";
import type { NaxConfig } from "../../../src/config/types";

describe("ConfigSelector", () => {
  describe("pickSelector", () => {
    test("select() picks named keys from config", () => {
      const sel = pickSelector("test", "routing");
      const cfg = {
        routing: { strategy: "keyword" },
      } as unknown as NaxConfig;
      expect(sel.select(cfg)).toEqual({
        routing: { strategy: "keyword" },
      });
    });

    test("name is set", () => {
      const sel = pickSelector("my-sel", "routing");
      expect(sel.name).toBe("my-sel");
    });

    test("picks multiple keys", () => {
      const sel = pickSelector("multi", "routing", "execution");
      const cfg = {
        routing: { strategy: "keyword" },
        execution: { parallel: true },
      } as unknown as NaxConfig;
      const result = sel.select(cfg);
      expect(result).toHaveProperty("routing");
      expect(result).toHaveProperty("execution");
    });
  });

  describe("reshapeSelector", () => {
    test("applies transform fn", () => {
      const sel = reshapeSelector("flat", (c: NaxConfig) => ({
        strategy: (c as unknown as { routing: { strategy: string } }).routing
          .strategy,
      }));
      const cfg = { routing: { strategy: "llm" } } as unknown as NaxConfig;
      expect(sel.select(cfg).strategy).toBe("llm");
    });

    test("name is set", () => {
      const sel = reshapeSelector("flat", () => ({}));
      expect(sel.name).toBe("flat");
    });

    test("returns arbitrary shape", () => {
      const sel = reshapeSelector("custom", (c: NaxConfig) => ({
        isParallel: (
          c as unknown as { execution: { parallel: boolean } }
        ).execution.parallel,
        agentName: "test",
      }));
      const cfg = {
        execution: { parallel: true },
      } as unknown as NaxConfig;
      const result = sel.select(cfg);
      expect(result.isParallel).toBe(true);
      expect(result.agentName).toBe("test");
    });
  });
});
