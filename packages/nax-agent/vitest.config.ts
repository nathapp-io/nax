import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/node/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
