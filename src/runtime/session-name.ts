import { createHash } from "node:crypto";
import type { SessionRole } from "./session-role";

export interface SessionNameRequest {
  workdir: string;
  featureName?: string;
  storyId?: string;
  role?: SessionRole;
  pipelineStage?: string;
}

export function formatSessionName(req: SessionNameRequest): string {
  const hash = createHash("sha256").update(req.workdir).digest("hex").slice(0, 8);
  const sanitize = (s: string) =>
    s
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .replace(/^-+|-+$/g, "");

  const parts = ["nax", hash];
  if (req.featureName) parts.push(sanitize(req.featureName));
  if (req.storyId) parts.push(sanitize(req.storyId));

  const suffix =
    req.role && req.role !== "main"
      ? req.role
      : req.pipelineStage && req.pipelineStage !== "run"
        ? req.pipelineStage
        : undefined;
  if (suffix) parts.push(sanitize(suffix));

  return parts.join("-");
}
