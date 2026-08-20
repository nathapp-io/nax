import { describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { PidRegistry } from "@/execution/pid-registry";

describe("PidRegistry concurrent writes", () => {
  test("interleaved register/unregister leave the file consistent with the live set", async () => {
    const dir = makeTempDir("nax-pid-serial-test-");
    try {
      const reg = new PidRegistry(dir);
      // Fire many concurrent register + unregister ops
      await Promise.all([
        reg.register(101),
        reg.register(102),
        reg.register(103),
        reg.unregister(101),
        reg.register(104),
        reg.unregister(102),
      ]);
      await reg.flush(); // new API
      const onDisk = await reg.readPidsFromDisk(); // new test helper
      // Disk must match the in-memory set exactly (no orphaned/duplicate lines)
      expect(new Set(onDisk)).toEqual(new Set(reg.snapshot()));
    } finally {
      cleanupTempDir(dir);
    }
  });
});
