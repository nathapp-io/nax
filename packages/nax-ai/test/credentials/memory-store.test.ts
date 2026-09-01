import { describe, expect, it } from "vitest";
import { createMemoryCredentialStore } from "../../src/credentials/memory-store.ts";
import type { StoredCredential } from "../../src/types.ts";

const KEY: StoredCredential = { kind: "api-key", key: "s3cret" };
const OAUTH: StoredCredential = { kind: "oauth", access: "a", refresh: "r", expires: 1 };

describe("createMemoryCredentialStore", () => {
  it("reads undefined for a provider it has never stored", async () => {
    expect(await createMemoryCredentialStore().read("openai")).toBeUndefined();
  });

  it("starts from the credentials it is seeded with", async () => {
    const store = createMemoryCredentialStore({ openai: KEY });
    expect(await store.read("openai")).toEqual(KEY);
  });

  it("does not write back into the object it was seeded with", async () => {
    const seed = { openai: KEY };
    await createMemoryCredentialStore(seed).modify("anthropic", async () => OAUTH);
    expect(seed).toEqual({ openai: KEY });
  });

  it("hands the current credential to the callback and returns what it stored", async () => {
    const store = createMemoryCredentialStore({ openai: KEY });
    const seen: (StoredCredential | undefined)[] = [];
    const returned = await store.modify("openai", async (current) => {
      seen.push(current);
      return OAUTH;
    });
    expect(seen).toEqual([KEY]);
    expect(returned).toEqual(OAUTH);
    expect(await store.read("openai")).toEqual(OAUTH);
  });

  it("removes the credential when the callback returns undefined", async () => {
    const store = createMemoryCredentialStore({ openai: KEY });
    expect(await store.modify("openai", async () => undefined)).toBeUndefined();
    expect(await store.read("openai")).toBeUndefined();
  });

  it("leaves other providers untouched when one is removed", async () => {
    const store = createMemoryCredentialStore({ openai: KEY, anthropic: OAUTH });
    await store.delete("openai");
    expect(await store.read("openai")).toBeUndefined();
    expect(await store.read("anthropic")).toEqual(OAUTH);
  });

  it("treats deleting an absent provider as a no-op rather than an error", async () => {
    await expect(createMemoryCredentialStore().delete("openai")).resolves.toBeUndefined();
  });

  it("releases its turn when the callback throws, so the store stays usable", async () => {
    const store = createMemoryCredentialStore();
    await expect(
      store.modify("openai", async () => {
        throw new Error("refresh failed");
      }),
    ).rejects.toThrow("refresh failed");
    await expect(store.modify("openai", async () => KEY)).resolves.toEqual(KEY);
  });

  /**
   * The file store holds a lock across the whole read-modify-write. `modify`
   * is async here too, so without serialisation two concurrent callers both
   * observe the pre-update value and the later write discards the earlier —
   * the same lost update, in one process. A consumer testing against this
   * store would not see a bug that production has.
   */
  it("serialises concurrent modifies rather than losing an update", async () => {
    const store = createMemoryCredentialStore({ openai: { kind: "api-key", key: "0" } });
    const bump = () =>
      store.modify("openai", async (current) => {
        const seen = current?.kind === "api-key" ? Number(current.key) : 0;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { kind: "api-key", key: String(seen + 1) };
      });

    await Promise.all(Array.from({ length: 6 }, bump));
    expect(await store.read("openai")).toEqual({ kind: "api-key", key: "6" });
  });

  it("keeps serialising after a callback throws", async () => {
    const store = createMemoryCredentialStore({ openai: { kind: "api-key", key: "0" } });
    const failing = store.modify("openai", async () => {
      throw new Error("boom");
    });
    const bump = store.modify("openai", async (current) => ({
      kind: "api-key",
      key: String(Number(current?.kind === "api-key" ? current.key : "0") + 1),
    }));

    await expect(failing).rejects.toThrow("boom");
    await bump;
    expect(await store.read("openai")).toEqual({ kind: "api-key", key: "1" });
  });
});
