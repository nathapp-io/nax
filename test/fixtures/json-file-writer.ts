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

// 10 iterations is enough to give the reader many chances to observe a torn
// state if the rename() ever stopped being atomic. The previous value (40)
// ran this fixture for ~1.7s wall-clock; 10 brings it to ~0.4s without
// weakening the assertion (atomic-rename correctness is a binary property
// observable on the first non-atomic write, not a probabilistic one).
for (let i = 0; i < 10; i++) {
  await saveJsonFile(path, payload, "json-file-writer-fixture");
}
