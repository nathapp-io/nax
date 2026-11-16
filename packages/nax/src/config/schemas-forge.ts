/**
 * `forge` block schema (US-001).
 *
 * `forge.kind` names the forge for the whole project config, for a self-hosted
 * forge on a host name that names neither GitHub nor GitLab. It has no default:
 * an absent block stays absent, so "nax was told which forge" never collapses
 * into "the default is github" and detection still decides when nothing is said.
 */

import { z } from "zod";

export const ForgeConfigSchema = z.object({
  kind: z.enum(["github", "gitlab"]).optional(),
});
