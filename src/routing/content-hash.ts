/**
 * Story Content Hash
 *
 * Computes a deterministic hash of the story content fields used for routing.
 * Used by the routing stage (RRP-003) to detect stale cached routing.
 */

import type { UserStory } from "../prd/types";

/**
 * Compute a deterministic hash of the story content fields used for routing.
 * Hash input: title + "\0" + description + "\0" + acceptanceCriteria.join("") + "\0" + tags.join("")
 *
 * Null-byte separators between fields prevent cross-field collisions.
 *
 * @param story - The user story to hash
 * @returns A hex string content hash
 */
export function computeStoryContentHash(story: UserStory): string {
  const input = `${story.title}\0${story.description}\0${story.acceptanceCriteria.join("")}\0${story.tags.join("")}`;

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}
