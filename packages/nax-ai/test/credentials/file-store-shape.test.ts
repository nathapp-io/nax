import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileCredentialStore } from "../../src/credentials/file-store.ts";
import type { StoredCredential } from "../../src/types.ts";

/**
 * A file this store cannot understand must be refused, not rewritten. Both of
 * these shapes were previously read as if they were version 1 credential maps:
 * an array was re-keyed as `"0"`, and a version 2 file was silently downgraded,
 * discarding every credential it held.
 */
const VERSION_2 = '{"version":2,"credentials":{"existing":{"kind":"api-key","key":"k"}}}';
const ARRAY = '{"version":1,"credentials":[{"providerId":"existing","kind":"api-key","key":"k"}]}';
const NO_VERSION = '{"credentials":{}}';
const NULL_CREDENTIALS = '{"version":1,"credentials":null}';
const VERSION_1 = '{"version":1,"credentials":{"existing":{"kind":"api-key","key":"k"}}}';

const NEW: StoredCredential = { kind: "api-key", key: "new" };
const NEWER: StoredCredential = { kind: "api-key", key: "newer" };

const dirs: string[] = [];

/** A fresh directory per case, so a test cannot see another case's file. */
function seed(contents: string): { path: string; bytes: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "nax-ai-shape-"));
  dirs.push(dir);
  const path = join(dir, "credentials.json");
  writeFileSync(path, contents, "utf8");
  return { path, bytes: readFileSync(path) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to reject, but it resolved");
}

const NOT_VERSION_1 = "is not a version 1 credential store";
const UNPARSABLE = "could not be parsed as a credential store";
const REFUSAL = "Refusing to overwrite it";

describe("createFileCredentialStore on an incompatible file", () => {
  it("refuses to modify a version 2 file", async () => {
    const { path } = seed(VERSION_2);
    const message = await rejectionMessage(createFileCredentialStore({ path }).modify("new", async () => NEW));
    expect(message).toContain(NOT_VERSION_1);
    expect(message).toContain(REFUSAL);
  });

  it("leaves a version 2 file byte-for-byte unchanged when modify is refused", async () => {
    const { path, bytes } = seed(VERSION_2);
    await rejectionMessage(createFileCredentialStore({ path }).modify("new", async () => NEW));
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it("refuses to modify a file whose credentials are an array", async () => {
    const { path } = seed(ARRAY);
    const message = await rejectionMessage(createFileCredentialStore({ path }).modify("new", async () => NEW));
    expect(message).toContain(UNPARSABLE);
  });

  it("leaves an array-shaped file byte-for-byte unchanged when modify is refused", async () => {
    const { path, bytes } = seed(ARRAY);
    await rejectionMessage(createFileCredentialStore({ path }).modify("new", async () => NEW));
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it("refuses to read a version 2 file", async () => {
    const { path } = seed(VERSION_2);
    const message = await rejectionMessage(createFileCredentialStore({ path }).read("existing"));
    expect(message).toContain(NOT_VERSION_1);
  });

  it("refuses a version 1 file whose credentials are null", async () => {
    const { path } = seed(NULL_CREDENTIALS);
    const message = await rejectionMessage(createFileCredentialStore({ path }).modify("new", async () => NEW));
    expect(message).toContain(UNPARSABLE);
  });

  it("refuses a file with a credentials map but no version", async () => {
    const { path } = seed(NO_VERSION);
    const message = await rejectionMessage(createFileCredentialStore({ path }).modify("new", async () => NEW));
    expect(message).toContain(NOT_VERSION_1);
  });

  it("keeps the stored key out of the refusal, naming only the file", async () => {
    // A distinctive secret, so "the message does not contain it" is a statement
    // about disclosure rather than about the letter k appearing in a temp path.
    const secret = "s3cret-key-material";
    const cases = [
      [
        `{"version":2,"credentials":{"existing":{"kind":"api-key","key":"${secret}"}}}`,
        `${NOT_VERSION_1}. ${REFUSAL}.`,
      ],
      [
        `{"version":1,"credentials":[{"providerId":"existing","kind":"api-key","key":"${secret}"}]}`,
        `${UNPARSABLE}. ${REFUSAL}.`,
      ],
    ] as const;
    for (const [shape, suffix] of cases) {
      const { path } = seed(shape);
      const message = await rejectionMessage(createFileCredentialStore({ path }).modify("new", async () => NEW));
      expect(message).not.toContain(secret);
      expect(message).not.toContain('"key"');
      // The path and nothing else: no JSON, no credential entry, no key.
      expect(message).toBe(`The credential file at ${path} ${suffix}`);
    }
  });

  it("still accepts a version 1 credentials map", async () => {
    const { path } = seed(VERSION_1);
    const store = createFileCredentialStore({ path });
    await expect(store.modify("new", async () => NEW)).resolves.toEqual(NEW);
  });

  it("writes both providers of a valid version 1 store back under version 1", async () => {
    const { path } = seed(VERSION_1);
    await createFileCredentialStore({ path }).modify("new", async () => NEW);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk).toEqual({
      version: 1,
      credentials: {
        existing: { kind: "api-key", key: "k" },
        new: NEW,
      },
    });
  });
});

describe("createFileCredentialStore read and delete on an incompatible file", () => {
  it("refuses to read a file whose credentials are an array", async () => {
    const { path } = seed(ARRAY);
    const message = await rejectionMessage(createFileCredentialStore({ path }).read("existing"));
    expect(message).toContain(UNPARSABLE);
  });

  it("refuses to delete from a version 2 file", async () => {
    const { path } = seed(VERSION_2);
    const message = await rejectionMessage(createFileCredentialStore({ path }).delete("existing"));
    expect(message).toContain(NOT_VERSION_1);
  });

  it("refuses to delete from a file whose credentials are an array", async () => {
    const { path } = seed(ARRAY);
    const message = await rejectionMessage(createFileCredentialStore({ path }).delete("existing"));
    expect(message).toContain(UNPARSABLE);
  });

  it.each([
    { label: "a version 2 file", shape: VERSION_2, operation: "read" as const },
    { label: "a version 2 file", shape: VERSION_2, operation: "delete" as const },
    { label: "an array-shaped file", shape: ARRAY, operation: "read" as const },
    { label: "an array-shaped file", shape: ARRAY, operation: "delete" as const },
  ])("leaves $label byte-for-byte unchanged after a refused $operation", async ({ shape, operation }) => {
    const { path, bytes } = seed(shape);
    const store = createFileCredentialStore({ path });
    await rejectionMessage(operation === "read" ? store.read("existing") : store.delete("existing"));
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it("does not modify the file when the callback would have changed it", async () => {
    const { path, bytes } = seed(VERSION_2);
    let callbackRan = false;
    await rejectionMessage(
      createFileCredentialStore({ path }).modify("existing", async () => {
        callbackRan = true;
        return NEWER;
      }),
    );
    expect(callbackRan).toBe(false);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });
});
