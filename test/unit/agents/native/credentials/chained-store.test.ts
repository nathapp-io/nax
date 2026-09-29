/**
 * US-004 — the chained credential store.
 *
 * `createChainedCredentialStore({ exec?, file })` is the seam that decides which
 * source serves a provider: the exec helper first (when configured), the file
 * store on a decline, and only ever one of them for modify/delete. A provider the
 * helper served is managed by the helper, so a write must refuse rather than
 * split the credential across two stores.
 *
 * The stores are plain fakes — this unit tests the chaining decision, not the
 * file store (nax-ai) or the helper (exec-source.test.ts). What a fake was asked
 * to do is recorded on a counter, because "the file store's delete was not
 * called" is exactly the guarantee AC4 states.
 */

import { describe, expect, test } from "bun:test";
import type { CredentialStore, StoredCredential } from "@nathapp/nax-ai";
import { assertNaxError } from "@test/helpers";
import { createChainedCredentialStore } from "@/agents/native/credentials/chained-store";
import type { ExecCredentialSource } from "@/agents/native/credentials/exec-source";
import type { NaxError } from "@/errors";

const FILE_CREDENTIAL: StoredCredential = { kind: "api-key", key: "FILE-KEY" };
const EXEC_CREDENTIAL: StoredCredential = { kind: "api-key", key: "HELPER-KEY" };

/** A file store that serves nothing unless a test overrides `read`. */
function makeFile(over: Partial<CredentialStore> = {}): CredentialStore {
  return {
    read: async () => undefined,
    modify: async () => undefined,
    delete: async () => {},
    ...over,
  };
}

/** An exec source that declines by default; `accountOf` follows `read`. */
function makeExec(over: Partial<ExecCredentialSource> = {}): ExecCredentialSource {
  return {
    read: async () => undefined,
    modify: async () => undefined,
    delete: async () => {},
    accountOf: () => undefined,
    ...over,
  };
}

/** `read`/`delete`/`modify` are expected to reject; returns the caught NaxError. */
async function caught(run: () => Promise<unknown>): Promise<NaxError> {
  try {
    await run();
  } catch (err) {
    assertNaxError(err, "chained store rejection");
    return err;
  }
  throw new Error("expected the chained store call to reject, but it resolved");
}

describe("createChainedCredentialStore", () => {
  describe("read", () => {
    test("AC1: returns the file store's credential when the exec source returns undefined", async () => {
      const chained = createChainedCredentialStore({
        exec: makeExec({ read: async () => undefined }),
        file: makeFile({ read: async () => FILE_CREDENTIAL }),
      });

      expect(await chained.read("anthropic")).toEqual(FILE_CREDENTIAL);
    });

    test("AC1 boundary: with no exec source, the file store serves the read", async () => {
      const chained = createChainedCredentialStore({ file: makeFile({ read: async () => FILE_CREDENTIAL }) });

      expect(await chained.read("anthropic")).toEqual(FILE_CREDENTIAL);
    });

    test("AC1 boundary: an exec source that serves a credential wins over the file store", async () => {
      let fileReads = 0;
      const chained = createChainedCredentialStore({
        exec: makeExec({ read: async () => EXEC_CREDENTIAL }),
        file: makeFile({
          read: async () => {
            fileReads += 1;
            return FILE_CREDENTIAL;
          },
        }),
      });

      expect(await chained.read("anthropic")).toEqual(EXEC_CREDENTIAL);
      expect(fileReads).toBe(0);
    });
  });

  describe("sourceOf", () => {
    test('AC2: after a declined exec read, sourceOf(p) returns "file"', async () => {
      const chained = createChainedCredentialStore({
        exec: makeExec({ read: async () => undefined }),
        file: makeFile({ read: async () => FILE_CREDENTIAL }),
      });

      await chained.read("anthropic");

      expect(chained.sourceOf("anthropic")).toBe("file");
    });

    test("AC2 boundary: sourceOf(p) is undefined before that provider has been read", () => {
      const chained = createChainedCredentialStore({ file: makeFile() });

      expect(chained.sourceOf("anthropic")).toBeUndefined();
    });

    test('boundary: sourceOf(p) returns "exec" once the exec source served p', async () => {
      const chained = createChainedCredentialStore({
        exec: makeExec({ read: async () => EXEC_CREDENTIAL }),
        file: makeFile({ read: async () => FILE_CREDENTIAL }),
      });

      await chained.read("anthropic");

      expect(chained.sourceOf("anthropic")).toBe("exec");
    });

    test("boundary: sourceOf is per provider — the other provider stays undefined", async () => {
      const chained = createChainedCredentialStore({
        exec: makeExec({ read: async () => EXEC_CREDENTIAL }),
        file: makeFile(),
      });

      await chained.read("anthropic");

      expect(chained.sourceOf("openai")).toBeUndefined();
    });
  });

  describe("modify and delete on a helper-served provider", () => {
    test("AC3: delete(p) throws NaxError code CREDENTIAL_MANAGED_BY_HELPER", async () => {
      const chained = createChainedCredentialStore({
        exec: makeExec({ read: async () => EXEC_CREDENTIAL }),
        file: makeFile(),
      });
      await chained.read("anthropic");

      const err = await caught(() => chained.delete("anthropic"));

      expect(err.code).toBe("CREDENTIAL_MANAGED_BY_HELPER");
    });

    test("AC4: delete(p) does not call the file store's delete", async () => {
      let fileDeletes = 0;
      const chained = createChainedCredentialStore({
        exec: makeExec({ read: async () => EXEC_CREDENTIAL }),
        file: makeFile({
          delete: async () => {
            fileDeletes += 1;
          },
        }),
      });
      await chained.read("anthropic");

      await caught(() => chained.delete("anthropic"));

      expect(fileDeletes).toBe(0);
    });

    test("AC5: modify(p, fn) throws NaxError code CREDENTIAL_MANAGED_BY_HELPER", async () => {
      const chained = createChainedCredentialStore({
        exec: makeExec({ read: async () => EXEC_CREDENTIAL }),
        file: makeFile(),
      });
      await chained.read("anthropic");

      const err = await caught(() => chained.modify("anthropic", async () => FILE_CREDENTIAL));

      expect(err.code).toBe("CREDENTIAL_MANAGED_BY_HELPER");
    });

    test("boundary: a file-served provider's delete reaches the file store", async () => {
      let fileDeletes = 0;
      const chained = createChainedCredentialStore({
        exec: makeExec({ read: async () => undefined }),
        file: makeFile({
          read: async () => FILE_CREDENTIAL,
          delete: async () => {
            fileDeletes += 1;
          },
        }),
      });
      await chained.read("anthropic");

      await chained.delete("anthropic");

      expect(fileDeletes).toBe(1);
    });

    test("boundary: modify on a provider that was never served goes to the file store", async () => {
      let fileModifies = 0;
      const chained = createChainedCredentialStore({
        exec: makeExec({ read: async () => EXEC_CREDENTIAL }),
        file: makeFile({
          modify: async () => {
            fileModifies += 1;
            return undefined;
          },
        }),
      });

      await chained.modify("anthropic", async () => FILE_CREDENTIAL);

      expect(fileModifies).toBe(1);
    });
  });

  describe("file-store failures", () => {
    test("AC6: a file-store read failure is rethrown as NaxError code CREDENTIAL_FILE_UNREADABLE", async () => {
      const chained = createChainedCredentialStore({
        file: makeFile({
          read: async () => {
            throw new Error("EACCES: permission denied");
          },
        }),
      });

      const err = await caught(() => chained.read("anthropic"));

      expect(err.code).toBe("CREDENTIAL_FILE_UNREADABLE");
    });

    test("AC7: the CREDENTIAL_FILE_UNREADABLE error carries the file store's original error as cause", async () => {
      const original = new Error("EACCES: permission denied");
      const chained = createChainedCredentialStore({
        file: makeFile({
          read: async () => {
            throw original;
          },
        }),
      });

      const err = await caught(() => chained.read("anthropic"));

      expect(err.context?.cause).toBe(original);
    });

    test("boundary: a file-store failure after a declined exec read is still CREDENTIAL_FILE_UNREADABLE", async () => {
      const chained = createChainedCredentialStore({
        exec: makeExec({ read: async () => undefined }),
        file: makeFile({
          read: async () => {
            throw new Error("EACCES: permission denied");
          },
        }),
      });

      const err = await caught(() => chained.read("anthropic"));

      expect(err.code).toBe("CREDENTIAL_FILE_UNREADABLE");
    });
  });

  describe("accountOf", () => {
    test('AC10: after the exec source served p with account "team-a", accountOf(p) returns "team-a"', async () => {
      const chained = createChainedCredentialStore({
        exec: makeExec({ read: async () => EXEC_CREDENTIAL, accountOf: () => "team-a" }),
        file: makeFile(),
      });

      await chained.read("anthropic");

      expect(chained.accountOf("anthropic")).toBe("team-a");
    });

    test("boundary: accountOf(p) is undefined when the file store served p", async () => {
      const chained = createChainedCredentialStore({
        exec: makeExec({ read: async () => undefined, accountOf: () => "team-a" }),
        file: makeFile({ read: async () => FILE_CREDENTIAL }),
      });

      await chained.read("anthropic");

      expect(chained.accountOf("anthropic")).toBeUndefined();
    });
  });
});
