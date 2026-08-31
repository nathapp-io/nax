import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Live tests reach real providers and cost money. They are opt-in through
    // `bun run test:live`; each also skips itself without a key, so a mis-run
    // is free rather than merely unlikely.
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
    environment: "node",
  },
});
