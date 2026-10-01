import { describe, expect, test } from "bun:test";
import { CommandSafetyConfigSchema } from "@/config";
import { NaxConfigSchema } from "@/config/schemas";
import { ExecutionConfigSchema } from "@/config/schemas-execution";

const parse = (shadow: Record<string, unknown>) => CommandSafetyConfigSchema.safeParse({ shadow });

describe("execution.commandSafety", () => {
  test("absent by default: the shadow is off", () => {
    expect(NaxConfigSchema.parse({}).execution.commandSafety).toBeUndefined();
  });

  test("defaults fill timeoutMs, authEnv and allowRemote", () => {
    const r = parse({ url: "http://127.0.0.1:8020/t/nax-command-safety/v1/systemone" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.shadow).toEqual({
        url: "http://127.0.0.1:8020/t/nax-command-safety/v1/systemone",
        timeoutMs: 3000,
        authEnv: "NAX_COMMAND_SAFETY_AUTH",
        allowRemote: false,
      });
    }
  });

  test.each(["http://127.0.0.1:8020/x", "http://localhost:8020/x", "http://[::1]:8020/x", "https://127.0.0.1/x"])(
    "loopback accepted: %s",
    (url) => {
      expect(parse({ url }).success).toBe(true);
    },
  );

  test.each([
    "http://127.0.0.1.evil.example/x",
    "http://localhost.evil/x",
    "http://10.0.0.5:8020/x",
    "https://api.example.com/v1/systemone",
    "ftp://127.0.0.1/x",
    "not a url",
  ])("rejected without allowRemote: %s (Review Focus 4)", (url) => {
    expect(parse({ url }).success).toBe(false);
  });

  test("allowRemote admits a remote http(s) host, but never a non-http scheme", () => {
    expect(parse({ url: "https://api.example.com/v1/systemone", allowRemote: true }).success).toBe(true);
    expect(parse({ url: "ftp://api.example.com/x", allowRemote: true }).success).toBe(false);
  });

  test.each([199, 30_001, 1.5])("timeoutMs out of range rejected: %p", (timeoutMs) => {
    expect(parse({ url: "http://127.0.0.1/x", timeoutMs }).success).toBe(false);
  });

  test("authEnv must be an env-var NAME, never a value", () => {
    expect(parse({ url: "http://127.0.0.1/x", authEnv: "sk-live-abc123" }).success).toBe(false);
  });

  test("is wired into the execution schema", () => {
    // A partial `execution` object fails NaxConfigSchema on unrelated required
    // fields, so assert through the execution schema's own field, as
    // test/unit/config/schemas-sandbox.test.ts does.
    const parsed = ExecutionConfigSchema.shape.commandSafety.parse({ shadow: { url: "http://127.0.0.1/x" } });
    expect(parsed?.shadow?.timeoutMs).toBe(3000);
  });
});
