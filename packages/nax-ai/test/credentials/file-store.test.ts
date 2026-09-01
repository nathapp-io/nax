import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileCredentialStore } from "../../src/credentials/file-store.ts";
import type { StoredCredential } from "../../src/types.ts";

const dirs: string[] = [];
function tempPath(name = "credentials.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "nax-ai-store-"));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  dirs.length = 0;
});

const KEY: StoredCredential = { kind: "api-key", key: "s3cret", env: { REGION: "eu" } };
const OAUTH: StoredCredential = { kind: "oauth", access: "a", refresh: "r", expires: 1 };

describe("createFileCredentialStore", () => {
  it("reads undefined for a provider it has never stored", async () => {
    const store = createFileCredentialStore({ path: tempPath() });
    expect(await store.read("openai")).toBeUndefined();
  });

  it("does not create the file merely by reading, so a read cannot mask a missing store", async () => {
    const path = tempPath();
    await createFileCredentialStore({ path }).read("openai");
    expect(() => statSync(path)).toThrow();
  });

  it("round-trips both credential kinds", async () => {
    const store = createFileCredentialStore({ path: tempPath() });
    await store.modify("openai", async () => KEY);
    await store.modify("anthropic", async () => OAUTH);
    expect(await store.read("openai")).toEqual(KEY);
    expect(await store.read("anthropic")).toEqual(OAUTH);
  });

  it("hands the current credential to the callback and returns what it stored", async () => {
    const store = createFileCredentialStore({ path: tempPath() });
    await store.modify("openai", async () => KEY);

    const seen: (StoredCredential | undefined)[] = [];
    const returned = await store.modify("openai", async (current) => {
      seen.push(current);
      return OAUTH;
    });

    expect(seen).toEqual([KEY]);
    expect(returned).toEqual(OAUTH);
  });

  it("removes the credential when the callback returns undefined", async () => {
    const store = createFileCredentialStore({ path: tempPath() });
    await store.modify("openai", async () => KEY);
    expect(await store.modify("openai", async () => undefined)).toBeUndefined();
    expect(await store.read("openai")).toBeUndefined();
  });

  it("leaves other providers untouched when one is removed", async () => {
    const store = createFileCredentialStore({ path: tempPath() });
    await store.modify("openai", async () => KEY);
    await store.modify("anthropic", async () => OAUTH);
    await store.delete("openai");
    expect(await store.read("openai")).toBeUndefined();
    expect(await store.read("anthropic")).toEqual(OAUTH);
  });

  it("treats deleting an absent provider as a no-op rather than an error", async () => {
    const store = createFileCredentialStore({ path: tempPath() });
    await expect(store.delete("openai")).resolves.toBeUndefined();
  });

  it("writes the file readable only by its owner", async () => {
    const path = tempPath();
    await createFileCredentialStore({ path }).modify("openai", async () => KEY);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });

  it("refuses to overwrite a file it cannot parse, rather than discarding credentials", async () => {
    const path = tempPath();
    const store = createFileCredentialStore({ path });
    await store.modify("openai", async () => KEY);
    writeFileSync(path, "{ not json", "utf8");

    await expect(store.modify("openai", async () => OAUTH)).rejects.toThrow(/could not be parsed/);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("releases the lock when the callback throws, so the store stays usable", async () => {
    const store = createFileCredentialStore({ path: tempPath() });
    await expect(
      store.modify("openai", async () => {
        throw new Error("refresh failed");
      }),
    ).rejects.toThrow("refresh failed");

    await expect(store.modify("openai", async () => KEY)).resolves.toEqual(KEY);
  });

  it("keeps the secret out of a parse failure's message", async () => {
    const path = tempPath();
    writeFileSync(path, `{"version":1,"credentials":{"openai":{"kind":"api-key","key":"s3cret"`, "utf8");
    await expect(createFileCredentialStore({ path }).read("openai")).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("s3cret") }),
    );
  });
});

/**
 * The reason this store exists. pi-ai serialises credential writes within one
 * process; concurrent `nax` invocations sharing one file do not, so a lost
 * update here silently discards a refreshed OAuth token.
 *
 * Real child processes, because in-process serialisation would pass a
 * same-process version of this test while the cross-process bug remained.
 */
describe("cross-process locking", () => {
  const WRITERS = 6;

  function bump(path: string): Promise<{ code: number | null; stderr: string }> {
    const script = join(import.meta.dirname, "support", "bump.ts");
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [script, path], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += String(c);
      });
      child.on("close", (code) => resolve({ code, stderr }));
    });
  }

  it("loses no update when separate processes modify the same file at once", async () => {
    const path = tempPath();
    const store = createFileCredentialStore({ path });
    await store.modify("openai", async () => ({ kind: "api-key", key: "0" }));

    const results = await Promise.all(Array.from({ length: WRITERS }, () => bump(path)));
    for (const r of results) expect(r.stderr === "" ? 0 : r.stderr).toBe(0);

    const final = await store.read("openai");
    // Each child read the counter, waited, then wrote back one more. Without a
    // lock spanning that read-modify-write, later writers overwrite earlier
    // ones and the total falls short of WRITERS.
    expect(final).toEqual({ kind: "api-key", key: String(WRITERS) });
  }, 30_000);
});
