/**
 * Answers one question: does an explicitly passed apiKey take precedence over
 * pi-ai's own credential resolution, or is it ignored?
 *
 * Run by hand. Not part of any suite.
 *   DEEPSEEK_API_KEY=sk-... bun run scripts/probe-apikey-precedence.ts
 */

import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const realKey = process.env.DEEPSEEK_API_KEY;
if (!realKey) {
  console.error("Set DEEPSEEK_API_KEY to run this probe.");
  process.exit(1);
}

const models = builtinModels();
const model = models.getModels("deepseek")[0];
if (!model) {
  console.error("No deepseek model in the catalog.");
  process.exit(1);
}

const context = { messages: [{ role: "user" as const, content: "Reply with the single word: ok", timestamp: 0 }] };

const attempt = async (label: string, apiKey: string): Promise<string> => {
  try {
    const stream = models.streamSimple(model, context, { apiKey, maxTokens: 16 });
    let text = "";
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.delta;
      if (event.type === "error") return `${label}: ERROR ${event.error.errorMessage ?? "unknown"}`;
    }
    return `${label}: OK ${JSON.stringify(text)}`;
  } catch (error) {
    return `${label}: THREW ${String(error)}`;
  }
};

// If the explicit key wins, the deliberately-wrong one must fail even though
// the environment holds a working key.
console.log(await attempt("explicit-wrong-key", "sk-definitely-not-valid"));
console.log(await attempt("explicit-real-key", realKey));
