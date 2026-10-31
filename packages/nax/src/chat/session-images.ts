import type { AgentSession } from "@nathapp/nax-agent";

/**
 * Whether an open session can read images, fail-safe. No session, a session whose backend
 * cannot say, and a capability that rejects all answer `false`: the screen asks this to
 * decide whether to offer an image send, and a failed probe must refuse rather than throw.
 */
export async function sessionAcceptsImages(session: AgentSession | undefined): Promise<boolean> {
  const accepts = session?.acceptsImages;
  if (accepts === undefined) return false;
  try {
    return await accepts.call(session);
  } catch {
    // Fail safe: an unanswerable capability is treated as "cannot read images".
    return false;
  }
}
