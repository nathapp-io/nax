import { z } from "zod";

export const FactsManifestSchema = z.object({
  repoFacts: z
    .array(
      z.object({
        id: z.string().regex(/^F-\d{3,}$/),
        kind: z.enum(["file", "symbol", "schema", "contract", "convention"]),
        evidence: z.string().min(1),
        summary: z.string().min(1),
      }),
    )
    .default([]),
  specClaims: z
    .array(
      z.object({
        id: z.string().regex(/^S-\d{3,}$/),
        specSpan: z.string().min(1),
        claim: z.string().min(1),
        kind: z.enum(["factual", "intent"]),
        verification: z.object({
          status: z.enum(["verified", "unverified", "partial", "contradicted"]),
          evidence: z.string().optional(),
          factId: z
            .string()
            .regex(/^F-\d{3,}$/)
            .optional(),
        }),
      }),
    )
    .default([]),
  gaps: z
    .array(
      z.object({
        id: z.string().regex(/^G-\d{3,}$/),
        kind: z.enum(["missing-context", "ignored-convention", "boundary-not-considered"]),
        note: z.string().min(1),
        evidence: z.string().optional(),
      }),
    )
    .default([]),
});

export type FactsManifest = z.infer<typeof FactsManifestSchema>;

export function parseFactsManifest(raw: unknown): { ok: true; manifest: FactsManifest } | { ok: false; error: string } {
  const result = FactsManifestSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, manifest: result.data };
}

export function renderManifestSection(manifest: FactsManifest): string {
  const lines: string[] = ["## Facts Manifest"];

  if (manifest.repoFacts.length > 0) {
    lines.push("\n### Repo Facts");
    for (const fact of manifest.repoFacts) {
      lines.push(`- ${fact.id} [${fact.kind}]: ${fact.summary}`);
    }
  }

  if (manifest.specClaims.length > 0) {
    lines.push("\n### Spec Claims");
    for (const claim of manifest.specClaims) {
      lines.push(`- ${claim.id} [${claim.kind}] (${claim.verification.status}): ${claim.claim}`);
    }
  }

  if (manifest.gaps.length > 0) {
    lines.push("\n### Gaps");
    for (const gap of manifest.gaps) {
      lines.push(`- ${gap.id} [${gap.kind}]: ${gap.note}`);
    }
  }

  return lines.join("\n");
}
