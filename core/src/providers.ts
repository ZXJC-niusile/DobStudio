/**
 * Provider registry and model discovery.
 *
 * The catalog data (presets, model tiers, default style) lives in `catalog.ts`
 * so a browser renderer can import it without dragging in the process,
 * filesystem and database layers. This module adds the two things that need a
 * network: enumerating a provider's models, and verifying a key end to end.
 */

import type { ProviderConfig } from "./types.ts";
import { chatCompletion } from "./translator.ts";

export {
  PROVIDER_PRESETS,
  ASR_LANGUAGES,
  DEFAULT_ASS_STYLE,
  QUALITY_TIERS,
  TARGET_LANGUAGES,
  WHISPER_MODELS,
  configFromPreset,
  presetById,
} from "./catalog.ts";
export type { ModelSpec, ProviderPreset } from "./catalog.ts";

export interface DiscoveredModel {
  id: string;
  ownedBy?: string;
  created?: number;
}

/**
 * `GET {baseUrl}/models` — the OpenAI-standard model listing.
 *
 * Many Chinese gateways implement it; some do not, and some require the key to
 * be valid before they answer anything useful. Failures return an empty list
 * rather than throwing, because a provider that cannot enumerate its models is
 * still perfectly usable with a hand-typed model name.
 */
export async function listModels(
  provider: ProviderConfig,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${provider.apiKey}`,
    ...provider.headers,
  };

  try {
    const response = await fetch(endpoint, { headers, signal });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: unknown };
    if (!Array.isArray(payload.data)) return [];
    return payload.data.flatMap((row) => {
      if (typeof row !== "object" || row === null) return [];
      const record = row as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : undefined;
      if (id === undefined) return [];
      return [
        {
          id,
          ownedBy: typeof record.owned_by === "string" ? record.owned_by : undefined,
          created: typeof record.created === "number" ? record.created : undefined,
        },
      ];
    });
  } catch {
    return [];
  }
}

export interface ConnectionTest {
  ok: boolean;
  message: string;
  /** Latency of the probe request, in milliseconds. */
  latencyMs?: number;
}

/**
 * Send a one-token request to verify the key, model and base URL all work.
 *
 * Cheaper and more decisive than a model listing: it exercises auth, the model
 * name and the chat endpoint in a single round trip.
 */
export async function testConnection(
  provider: ProviderConfig,
  signal?: AbortSignal,
): Promise<ConnectionTest> {
  const startedAt = Date.now();
  try {
    const reply = await chatCompletion(
      provider,
      [{ role: "user", content: "Reply with the single word: ok" }],
      signal,
    );
    return {
      ok: true,
      message: `Connected. Model replied: ${reply.trim().slice(0, 40)}`,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    };
  }
}
