import { expect, test } from "bun:test";
import { join } from "node:path";
import { _curatorCmdDeps } from "@/commands/curator";

test("warns instead of rejecting when an argument-bearing editor cannot start", async () => {
  const previousEditor = process.env.EDITOR;
  process.env.EDITOR = "missing-editor --wait";

  try {
    await expect(_curatorCmdDeps.openInEditor(join(process.cwd(), "rule.md"))).resolves.toBeUndefined();
  } finally {
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
  }
});
