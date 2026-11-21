import { describe, expect, test } from "bun:test";
import { expandConfigModelAliases } from "@/config/model-alias-expand";
import { NaxError } from "@/errors";

const SOL = { agent: { modelAliases: { sol: "a/b" } } };

function at(value: unknown, ...keys: Array<string | number>): unknown {
  let cur = value;
  for (const k of keys) cur = Reflect.get(Object(cur), k);
  return cur;
}

function caught(fn: () => unknown): NaxError {
  try {
    fn();
  } catch (err) {
    if (err instanceof NaxError) return err;
    throw err;
  }
  throw new Error("expected throw");
}

describe("expandConfigModelAliases", () => {
  test("AC-1 string tier entry", () => {
    const out = expandConfigModelAliases({ ...SOL, models: { native: { powerful: "@sol[medium]" } } });
    expect(at(out, "models", "native", "powerful")).toBe("a/b[medium]");
  });
  test("AC-2 ModelDef model field", () => {
    const out = expandConfigModelAliases({ ...SOL, models: { native: { fast: { provider: "a", model: "@sol" } } } });
    expect(at(out, "models", "native", "fast", "model")).toBe("a/b");
  });
  test("AC-3 bot.models selector", () => {
    const out = expandConfigModelAliases({ ...SOL, bot: { models: { review: { agent: "native", model: "@sol" } } } });
    expect(at(out, "bot", "models", "review", "model")).toBe("a/b");
  });
  test("AC-4 advisor.fallbackModels array", () => {
    const out = expandConfigModelAliases({
      ...SOL,
      advisor: { fallbackModels: [{ agent: "native", model: "@sol[low]" }] },
    });
    expect(at(out, "advisor", "fallbackModels", 0, "model")).toBe("a/b[low]");
  });
  test("AC-5 agent.fallback.map rung", () => {
    const out = expandConfigModelAliases({
      agent: { modelAliases: { sol: "a/b" }, fallback: { map: { native: [{ agent: "native", model: "@sol" }] } } },
    });
    expect(at(out, "agent", "fallback", "map", "native", 0, "model")).toBe("a/b");
  });
  test("AC-6 review.semantic.model object", () => {
    const out = expandConfigModelAliases({
      ...SOL,
      review: { semantic: { model: { agent: "native", model: "@sol" } } },
    });
    expect(at(out, "review", "semantic", "model", "model")).toBe("a/b");
  });
  test("AC-7 string-form selector unchanged", () => {
    const raw = { ...SOL, bot: { models: { fix: "@sol" } } };
    expect(expandConfigModelAliases(raw)).toEqual(raw);
  });
  test("AC-8 plugins untouched", () => {
    const raw = { plugins: [{ module: "@nathapp/x" }] };
    expect(expandConfigModelAliases(raw)).toEqual(raw);
  });
  test("AC-9 routing.agents untouched", () => {
    const raw = { ...SOL, routing: { agents: { profiles: [{ target: { agent: "native", model: "@sol" } }] } } };
    expect(expandConfigModelAliases(raw)).toEqual(raw);
  });
  test("AC-10 chat untouched", () => {
    const raw = { ...SOL, chat: { workflow: { specWriter: { agent: "native", model: "@sol" } } } };
    expect(expandConfigModelAliases(raw)).toEqual(raw);
  });
  test("AC-11 never mutates input", () => {
    const raw = {
      ...SOL,
      models: { native: { powerful: "@sol" } },
      advisor: { fallbackModels: [{ agent: "native", model: "@sol" }] },
    };
    const before = structuredClone(raw);
    expandConfigModelAliases(raw);
    expect(raw).toEqual(before);
  });
  test("AC-12 no aliases, no @ strings: deep-equal", () => {
    const raw = { models: { native: { fast: "a/b" } }, x: [1, { y: "z" }] };
    expect(expandConfigModelAliases(raw)).toEqual(raw);
  });
  test("AC-13 non-object modelAliases gives MODEL_ALIAS_INVALID", () => {
    const raw = { agent: { modelAliases: "oops" }, bot: { models: { review: { agent: "native", model: "@sol" } } } };
    const err = caught(() => expandConfigModelAliases(raw));
    expect(err.code).toBe("MODEL_ALIAS_INVALID");
    expect(err.message).toContain('unknown model alias "sol"');
  });
  test("single bad reference preserves its expansion context", () => {
    const err = caught(() =>
      expandConfigModelAliases({ bot: { models: { review: { agent: "native", model: "@nope" } } } }),
    );
    expect(err.code).toBe("MODEL_ALIAS_INVALID");
    expect(err.context).toEqual({
      stage: "config",
      path: "bot.models.review.model",
      alias: "nope",
      paths: ["bot.models.review.model"],
    });
    expect(err.message).toBe('bot.models.review.model: unknown model alias "nope"');
  });
  test("AC-14/17 aggregates every bad reference in one error", () => {
    const raw = {
      bot: { models: { review: { agent: "native", model: "@sol" } } },
      models: { native: { fast: "@missing" } },
    };
    const err = caught(() => expandConfigModelAliases(raw));
    expect(err.code).toBe("MODEL_ALIAS_INVALID");
    expect(err.context).toMatchObject({ stage: "config", path: "bot.models.review.model", alias: "sol" });
    expect([...String(err.context?.paths).split(",")].sort()).toEqual([
      "bot.models.review.model",
      "models.native.fast",
    ]);
    const lines = err.message.split("\n");
    expect(lines).toContain('bot.models.review.model: unknown model alias "sol"');
    expect(lines).toContain('models.native.fast: unknown model alias "missing"');
    expect(lines).toHaveLength(2);
  });
  test("AC-15 absent modelAliases", () => {
    const err = caught(() =>
      expandConfigModelAliases({ bot: { models: { review: { agent: "native", model: "@sol" } } } }),
    );
    expect(err.code).toBe("MODEL_ALIAS_INVALID");
    expect(err.message).toContain('unknown model alias "sol"');
  });
  test("AC-16 non-object modelAliases, multiple refs each reported", () => {
    const raw = {
      agent: { modelAliases: 5 },
      models: { native: { fast: "@a", powerful: { provider: "p", model: "@b" } } },
      plan: { model: { agent: "native", model: "@c" } },
    };
    const err = caught(() => expandConfigModelAliases(raw));
    expect(err.message).toContain('models.native.fast: unknown model alias "a"');
    expect(err.message).toContain('models.native.powerful.model: unknown model alias "b"');
    expect(err.message).toContain('plan.model.model: unknown model alias "c"');
  });
  test("F2 a tier named model is expanded", () => {
    const out = expandConfigModelAliases({ ...SOL, models: { native: { model: "@sol" } } });
    expect(at(out, "models", "native", "model")).toBe("a/b");
  });
  test("F3 own __proto__ key is preserved", () => {
    const raw = JSON.parse('{"x":{"__proto__":{"agent":"n","model":"@sol"}}}');
    const out = expandConfigModelAliases({ ...SOL, ...raw });
    const x = at(out, "x");
    expect(Object.getPrototypeOf(x)).toBe(Object.prototype);
    expect(Object.keys(Object(x))).toEqual(["__proto__"]);
  });
});
