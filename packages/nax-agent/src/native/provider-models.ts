/**
 * The models the catalog offers for one provider, as plain data. The catalog is
 * nax-ai's; nothing here carries a nax-ai type (see check-nax-ai-imports).
 */
import { byCodePoint } from "#src/internal/sort";
import { getNativeClient, type NativeCatalogOverrides } from "./client.ts";

export interface ProviderModel {
  /** The model id without its provider prefix; the config string is `<provider>/<id>`. */
  readonly id: string;
  readonly contextWindow: number;
  /** The output ceiling, when the catalog states one. */
  readonly maxTokens?: number;
}

/**
 * Tool-capable models for `providerId`, sorted by id. An unknown provider gives
 * an empty list. A catalog that cannot load rejects.
 */
export async function listProviderModels(
  providerId: string,
  catalogOverrides: NativeCatalogOverrides = [],
): Promise<readonly ProviderModel[]> {
  const client = await getNativeClient(catalogOverrides);
  const models = await client.listModels(providerId);
  return models
    .filter((model) => model.supportsTools)
    .map((model) => ({
      id: model.id,
      contextWindow: model.contextWindow,
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    }))
    .sort((a, b) => byCodePoint(a.id, b.id));
}
