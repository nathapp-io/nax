import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StoryStatus } from "../prd";

export async function appendProgress(
  featureDir: string,
  storyId: string,
  status: StoryStatus,
  message: string,
): Promise<void> {
  mkdirSync(featureDir, { recursive: true });
  const progressPath = join(featureDir, "progress.txt");
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${storyId} — ${status.toUpperCase()} — ${message}\n`;

  // Append to file (creates if doesn't exist)
  const file = Bun.file(progressPath);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(progressPath, existing + entry);
}
