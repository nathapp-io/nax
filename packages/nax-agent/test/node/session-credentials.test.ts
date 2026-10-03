import { describe, expect, test } from "vitest";
import { createSessionCredentialStore } from "#src/native/credentials/session-source";

describe("session credential source on Node", () => {
  test("memory source reads and stamps without configureCredentials", async () => {
    const store = createSessionCredentialStore({
      kind: "memory",
      credentials: { anthropic: { kind: "api-key", key: "sk-node" } },
    });
    expect(await store.read("anthropic")).toEqual({ kind: "api-key", key: "sk-node" });
    expect(store.servedAuth("anthropic")?.source).toBe("memory");
  });
});
