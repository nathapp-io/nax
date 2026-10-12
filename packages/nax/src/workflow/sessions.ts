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
  let descriptors: ReturnType<typeof sessionManager.getForStory>;
  try {
    descriptors = sessionManager.getForStory(storyId);
  } catch (err) {
    getLogger().warn("workflow", "Could not list story sessions, continuing", { storyId, error: errorMessage(err) });
    return;
  }
  for (const desc of descriptors) {
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
