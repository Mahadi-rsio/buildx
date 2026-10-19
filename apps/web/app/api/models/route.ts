import { envStatus, providerEndpoint, type ModelProviderId } from "@buildx/shared";

export const dynamic = "force-dynamic";

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  /** Human label for the provider (LiteLLM / Vercel). */
  provider?: string;
  /** Provider id used by the UI to group models into sections. */
  providerId?: ModelProviderId | string;
}

/**
 * Fallback catalog for the Vercel AI Gateway when its `/models` endpoint
 * cannot be reached. The live endpoint normally returns the full catalog.
 */
const VERCEL_FALLBACK_MODELS: ModelOption[] = [
  {
    id: "anthropic/claude-3-7-sonnet-20250219",
    name: "Claude 3.7 Sonnet",
    description: "Extended-thinking software engineering model",
    provider: "Vercel",
    providerId: "vercel",
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    description: "High-intelligence flagship multimodal model",
    provider: "Vercel",
    providerId: "vercel",
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    description: "Fast, cost-efficient everyday model",
    provider: "Vercel",
    providerId: "vercel",
  },
  {
    id: "google/gemini-2.0-flash-001",
    name: "Gemini 2.0 Flash",
    description: "Fast multimodal model from Google",
    provider: "Vercel",
    providerId: "vercel",
  },
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek Chat (V3)",
    description: "Fast general intelligence & coding",
    provider: "Vercel",
    providerId: "vercel",
  },
];

/** Turn an id like `deepseek/deepseek-v4-flash-0731` into a readable label. */
function prettifyId(id: string): string {
  const leaf = id.includes("/") ? id.split("/").pop() ?? id : id;
  return leaf
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

const CHAT_UNSUPPORTED = /(embedding|whisper|tts|dall-e|moderation|image-|rerank)/i;

interface RemoteModel {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  tags?: string[];
}

const CATALOG_TTL_MS = 5 * 60_000;
let catalogCache: { expiresAt: number; models: ModelOption[] } | null = null;

/** Best-effort `/models` fetch from the Vercel AI Gateway (cached in-process). */
async function fetchVercelCatalog(
  baseURL: string,
  apiKey: string,
): Promise<ModelOption[]> {
  if (catalogCache && catalogCache.expiresAt > Date.now()) {
    return catalogCache.models;
  }

  const targetUrl = `${baseURL.replace(/\/+$/, "")}/models`;
  const cacheFallback = (): ModelOption[] => {
    catalogCache = {
      expiresAt: Date.now() + CATALOG_TTL_MS,
      models: VERCEL_FALLBACK_MODELS,
    };
    return VERCEL_FALLBACK_MODELS;
  };

  let res: Response;
  try {
    res = await fetch(targetUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Cache the failure so an unreachable gateway does not add an 8s timeout
    // to every picker mount until the next TTL window.
    return cacheFallback();
  }
  if (!res.ok) return cacheFallback();

  const json = (await res.json()) as { data?: RemoteModel[] };
  if (!Array.isArray(json.data) || json.data.length === 0) {
    return cacheFallback();
  }

  const models = json.data
    .filter(
      (model) =>
        typeof model.id === "string" &&
        model.id.trim().length > 0 &&
        !CHAT_UNSUPPORTED.test(model.id) &&
        (model.type === undefined || model.type === "language"),
    )
    .map((model) => ({
      id: model.id.trim(),
      name: model.name?.trim() || prettifyId(model.id),
      description:
        model.description?.trim().slice(0, 160) ||
        model.tags?.slice(0, 3).join(" · ") ||
        model.id,
      provider: "Vercel",
      providerId: "vercel",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  catalogCache = { expiresAt: Date.now() + CATALOG_TTL_MS, models };
  return models;
}

export async function GET(): Promise<Response> {
  const env = envStatus();
  const vercel = providerEndpoint("vercel");
  const litellmEnabled = env.providers.some(
    (provider) => provider.id === "litellm" && provider.hasApiKey,
  );

  const seen = new Set<string>();
  const models: ModelOption[] = [];

  const push = (option: ModelOption): void => {
    if (seen.has(option.id)) return;
    seen.add(option.id);
    models.push(option);
  };

  let defaultModel = env.model;

  // LiteLLM exposes a single model to the app: `auto`. The proxy fans out to
  // the configured upstreams; picking a concrete upstream is a Vercel model.
  if (litellmEnabled) {
    push({
      id: "auto",
      name: "Auto",
      description: "Automatic routing via the LiteLLM proxy",
      provider: "LiteLLM",
      providerId: "litellm",
    });
    defaultModel = "auto";
  }

  // Full Vercel AI Gateway catalog (all chat/language models).
  if (vercel.baseURL && vercel.apiKey) {
    let vercelModels: ModelOption[] = [];
    try {
      vercelModels = await fetchVercelCatalog(vercel.baseURL, vercel.apiKey);
    } catch {
      // Unreachable or unauthenticated — fall through to the fallback catalog.
    }
    if (vercelModels.length === 0) vercelModels = VERCEL_FALLBACK_MODELS;
    for (const model of vercelModels) push(model);
    if (!litellmEnabled && vercelModels[0]) defaultModel = vercelModels[0].id;
  }

  return Response.json({ default: defaultModel, models });
}
