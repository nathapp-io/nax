// Standalone writer process for test/unit/utils/json-file.test.ts's cross-process
// torn-read regression test. Must run in its own OS process — same-process
// writes complete as a single microtask-scheduled unit, so a same-process
// reader can never observe a mid-write file regardless of whether the write
// is atomic.
import { saveJsonFile } from "@/utils/json-file";

const path = process.argv[2];
if (!path) {
  throw new Error("usage: bun json-file-writer.ts <path>");
}

const payload = {
  items: Array.from({ length: 100_000 }, (_, i) => ({ id: i, note: "x".repeat(100) })),
};

for (let i = 0; i < 40; i++) {
  await saveJsonFile(path, payload, "json-file-writer-fixture");
}
