import { describe, expect, test } from "bun:test";
import { expandModelAliasRef, MODEL_ALIAS_PREFIX } from "@/config";
import { NaxError } from "@/errors";

function thrown(fn: () => unknown): NaxError {
  try {
    fn();
  } catch (err) {
    if (err instanceof NaxError) return err;
    throw err;
  }
  throw new Error("expected expandModelAliasRef to throw");
}

const SOL = { sol: "openai-codex/gpt-6.1-sol" };

describe("expandModelAliasRef", () => {
  test("exports the @ prefix", () => {
    expect(MODEL_ALIAS_PREFIX).toBe("@");
  });

  test("AC-1 returns the alias value for a bare reference", () => {
    expect(expandModelAliasRef("@sol", SOL, "bot.models.review.model")).toBe("openai-codex/gpt-6.1-sol");
  });

  test("AC-2 appends the reference effort", () => {
    expect(expandModelAliasRef("@sol[high]", SOL, "p")).toBe("openai-codex/gpt-6.1-sol[high]");
  });

  test("AC-3 reference effort replaces the value's suffix", () => {
    const aliases = { sol: "openai-codex/gpt-6.1-sol[medium]" };
    expect(expandModelAliasRef("@sol[high]", aliases, "p")).toBe("openai-codex/gpt-6.1-sol[high]");
  });

  test("AC-4 keeps the value's suffix when the reference has none", () => {
    const aliases = { sol: "openai-codex/gpt-6.1-sol[medium]" };
    expect(expandModelAliasRef("@sol", aliases, "p")).toBe("openai-codex/gpt-6.1-sol[medium]");
  });

  test("AC-5 matches keys as trimmed", () => {
    expect(expandModelAliasRef("@sol", { " sol ": "a/b" }, "p")).toBe("a/b");
  });

  test("AC-6/7/17 unknown alias: code, message and context", () => {
    const err = thrown(() => expandModelAliasRef("@nope", {}, "bot.models.review.model"));
    expect(err.code).toBe("MODEL_ALIAS_INVALID");
    expect(err.message).toBe('bot.models.review.model: unknown model alias "nope"');
    expect(err.context).toMatchObject({ stage: "config", path: "bot.models.review.model", alias: "nope" });
  });

  test("AC-8 inherited object keys are not aliases", () => {
    expect(thrown(() => expandModelAliasRef("@toString", {}, "p")).code).toBe("MODEL_ALIAS_INVALID");
  });

  test("AC-9 refuses an alias value that is another alias", () => {
    expect(thrown(() => expandModelAliasRef("@a", { a: "@b" }, "p")).message).toContain(
      'model alias "a" must be a literal model id, not another alias',
    );
  });

  test("AC-10 refuses an acp: target", () => {
    expect(thrown(() => expandModelAliasRef("@r", { r: "acp:codex/gpt-6.1-terra" }, "p")).message).toContain(
      'model alias "r" is an acp: target, usable only from agent files',
    );
  });

  test("AC-11 refuses a value that is not provider/model", () => {
    expect(thrown(() => expandModelAliasRef("@x", { x: "no-provider" }, "p")).message).toContain(
      'model alias "x" is not a provider/model id',
    );
  });

  test("AC-12/15 empty references", () => {
    expect(thrown(() => expandModelAliasRef("@[high]", { sol: "a/b" }, "p")).message).toContain(
      "empty model alias reference",
    );
    const err = thrown(() => expandModelAliasRef("@", {}, "p"));
    expect(err.code).toBe("MODEL_ALIAS_INVALID");
    expect(err.message).toContain("empty model alias reference");
  });

  test.each(["@sol[high", "@sol[]", "@sol[a][b]", "@sol[high]x"])("AC-13 malformed reference %s", (ref) => {
    expect(thrown(() => expandModelAliasRef(ref, { sol: "a/b" }, "p")).message).toContain(
      "malformed model alias reference",
    );
  });

  test("AC-14 non-string alias value is invalid, not a crash", () => {
    const bad = JSON.parse('{"sol":42}');
    const err = thrown(() => expandModelAliasRef("@sol", bad, "p"));
    expect(err.code).toBe("MODEL_ALIAS_INVALID");
    expect(err.message).toContain("not a provider/model id");
  });

  test("AC-16 whitespace after @ is malformed", () => {
    const err = thrown(() => expandModelAliasRef("@ sol", { sol: "a/b" }, "p"));
    expect(err.code).toBe("MODEL_ALIAS_INVALID");
    expect(err.message).toContain('malformed model alias reference "@ sol"');
  });
});
