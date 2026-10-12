/** Close the story's live wf-implementer session so the next turn really is fresh (spec §5.5, P2-R5). */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import type { ISessionManager } from "@/session/types";

const LIVE_STATES = new Set(["RUNNING", "CREATED"]);

export async function closeImplementerSession(
  sessionManager: Pick<ISessionManager, "getForStory" | "getLiveHandle" | "closeSession"> | undefined,
  storyId: string,
): Promise<void> {
  if (!sessionManager) return;
  for (const desc of sessionManager.getForStory(storyId)) {
    if (desc.role !== "wf-implementer" || !desc.handle || !LIVE_STATES.has(desc.state)) continue;
    const live = sessionManager.getLiveHandle(desc.handle);
    if (!live) continue;
    try {
      await sessionManager.closeSession(live);
    } catch (err) {
      getLogger().warn("workflow", "Failed to close wf-implementer session, continuing", {
        storyId,
        sessionName: desc.handle,
        error: errorMessage(err),
      });
    }
  }
}
