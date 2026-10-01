/**
 * Child process for the cross-process locking test: read the counter, pause to
 * widen the race window, write it back incremented. Run directly by the test
 * with process.execPath, so it must stay runnable as a standalone script.
 */
import { createFileCredentialStore } from "../../../src/credentials/file-store.ts";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: bump.ts <path>");

await createFileCredentialStore({ path }).modify("openai", async (current) => {
  const seen = current?.kind === "api-key" ? Number(current.key) : 0;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { kind: "api-key", key: String(seen + 1) };
});
