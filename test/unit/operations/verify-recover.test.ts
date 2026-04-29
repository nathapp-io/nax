import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { _runPostParseForTest } from "../../../src/operations/call";
import type { BuildContext, VerifyContext } from "../../../src/operations/types";
import { withTempDir } from "../../helpers/temp";

// Minimal build context — verify/recover hooks under test don't use packageView/config.
const FAKE_CTX = {
  packageView: null,
  config: null,
} as unknown as BuildContext<unknown>;

describe("runPostParse — no hooks", () => {
  test("op without verify or recover returns parse output unchanged", async () => {
    const result = await _runPostParseForTest({}, "from-parse", "input", FAKE_CTX);
    expect(result).toBe("from-parse");
  });
});

describe("runPostParse — verify hook", () => {
  test("op.verify returning non-null wins over parsed value", async () => {
    const op = {
      verify: async (_parsed: string) => "from-verify" as string | null,
    };
    const result = await _runPostParseForTest(op, "from-parse", "input", FAKE_CTX);
    expect(result).toBe("from-verify");
  });

  test("op.verify returning null falls through to recover", async () => {
    const op = {
      verify: async () => null as string | null,
      recover: async () => "from-recover" as string | null,
    };
    const result = await _runPostParseForTest(op, "from-parse", "input", FAKE_CTX);
    expect(result).toBe("from-recover");
  });

  test("both verify and recover null → final ?? parsed returns original parsed", async () => {
    const op = {
      verify: async () => null as string | null,
      recover: async () => null as string | null,
    };
    const result = await _runPostParseForTest(op, "from-parse", "input", FAKE_CTX);
    expect(result).toBe("from-parse");
  });

  test("recover not called when verify returns non-null", async () => {
    let recoverCalled = false;
    const op = {
      verify: async () => "from-verify" as string | null,
      recover: async () => {
        recoverCalled = true;
        return "from-recover" as string | null;
      },
    };
    const result = await _runPostParseForTest(op, "from-parse", "input", FAKE_CTX);
    expect(result).toBe("from-verify");
    expect(recoverCalled).toBe(false);
  });
});

describe("runPostParse — VerifyContext filesystem helpers", () => {
  test("VerifyContext.readFile reads existing file and returns null for missing file", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "artifact.txt");
      await Bun.write(filePath, "artifact content");

      let capturedCtx: VerifyContext<unknown> | null = null;
      const op = {
        verify: async (
          _parsed: string,
          _input: unknown,
          ctx: VerifyContext<unknown>,
        ): Promise<string | null> => {
          capturedCtx = ctx;
          return null;
        },
      };

      await _runPostParseForTest(op, "ignored", "input", FAKE_CTX);

      const content = await capturedCtx!.readFile(filePath);
      expect(content).toBe("artifact content");

      const missing = await capturedCtx!.readFile(join(dir, "nonexistent.txt"));
      expect(missing).toBeNull();
    });
  });

  test("VerifyContext.fileExists returns true for existing and false for missing", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "artifact.txt");
      await Bun.write(filePath, "content");

      let capturedCtx: VerifyContext<unknown> | null = null;
      const op = {
        verify: async (
          _parsed: string,
          _input: unknown,
          ctx: VerifyContext<unknown>,
        ): Promise<string | null> => {
          capturedCtx = ctx;
          return null;
        },
      };

      await _runPostParseForTest(op, "ignored", "input", FAKE_CTX);

      expect(await capturedCtx!.fileExists(filePath)).toBe(true);
      expect(await capturedCtx!.fileExists(join(dir, "nonexistent.txt"))).toBe(false);
    });
  });
});
