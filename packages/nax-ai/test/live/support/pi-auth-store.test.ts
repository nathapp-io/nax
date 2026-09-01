import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { piAuthStore } from "./pi-auth-store.ts";

function fixtureFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "nax-ai-auth-"));
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify(contents), "utf8");
  return file;
}

describe("piAuthStore", () => {
  it("maps pi's api_key entry onto the api-key credential", async () => {
    const store = piAuthStore(fixtureFile({ "opencode-go": { type: "api_key", key: "literal-value" } }));
    expect(await store.read("opencode-go")).toEqual({ kind: "api-key", key: "literal-value" });
  });

  it("maps pi's oauth entry onto the oauth credential", async () => {
    const store = piAuthStore(
      fixtureFile({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 123, accountId: "acc" } }),
    );
    expect(await store.read("openai-codex")).toEqual({ kind: "oauth", access: "a", refresh: "r", expires: 123 });
  });

  it("returns undefined for a provider with no stored credential", async () => {
    const store = piAuthStore(fixtureFile({}));
    expect(await store.read("nobody")).toBeUndefined();
  });

  it("refuses to write, so a rotated token is never silently lost", async () => {
    const store = piAuthStore(fixtureFile({}));
    await expect(store.modify("x", async () => undefined)).rejects.toThrow(/read-only/);
    await expect(store.delete("x")).rejects.toThrow(/read-only/);
  });
});
