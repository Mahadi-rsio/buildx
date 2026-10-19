import {
  envStatus,
  providerEndpoint,
  type ModelProviderId,
} from "@buildx/shared";

export const dynamic = "force-dynamic";

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  /** Human label for the provider (OmniRoute / Vercel / ...). */
  provider?: string;
  /** Provider id used by the UI to group models into sections. */
  providerId?: ModelProviderId | string;
}

/**
 * Fallback catalog for the primary (OmniRoute) provider, used only when its
 * `/models` endpoint cannot be reached. The active default (from `AGENT_MODEL`)
 * is always injected first, so the picker never advertises a model the server
 * would reject.
 */
const FALLBACK_MODELS: ModelOption[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek Chat (V3)",
    description: "Fast general intelligence & coding",
    provider: "OmniRoute",
    providerId: "omniroute",
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner (R1)",
    description: "Deep chain-of-thought reasoning",
    provider: "OmniRoute",
    providerId: "omniroute",
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    description: "High-intelligence flagship multimodal model",
    provider: "OmniRoute",
    providerId: "omniroute",
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    description: "Fast, cost-efficient everyday model",
    provider: "OmniRoute",
    providerId: "omniroute",
  },
];

/**
 * Paid models served by the Vercel AI Gateway. Used when the gateway is
 * configured but its `/models` endpoint does not list models (gateways often
 * omit it). Ids use the gateway's `provider/model` format. Tweak this list to
 * match the models you enable on your gateway.
 */
const VERCEL_PAID_MODELS: ModelOption[] = [
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
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    description: "Long-context flagship model",
    provider: "Vercel",
    providerId: "vercel",
  },
  {
    id: "openai/o3-mini",
    name: "O3 Mini",
    description: "Reasoning model, fast and affordable",
    provider: "Vercel",
    providerId: "vercel",
  },
  {
    id: "anthropic/claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet",
    description: "Specialized in software engineering",
    provider: "Vercel",
    providerId: "vercel",
  },
  {
    id: "anthropic/claude-3-7-sonnet-20250219",
    name: "Claude 3.7 Sonnet",
    description: "Extended-thinking software engineering model",
    provider: "Vercel",
    providerId: "vercel",
  },
  {
    id: "anthropic/claude-3-5-haiku-20241022",
    name: "Claude 3.5 Haiku",
    description: "Fast, cost-efficient Anthropic model",
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
  {
    id: "deepseek/deepseek-reasoner",
    name: "DeepSeek Reasoner (R1)",
    description: "Deep chain-of-thought reasoning",
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

const CHAT_UNSUPPORTED = /(embedding|whisper|tts|dall-e|moderation|image-)/i;

/** Best-effort `/models` fetch from an OpenAI-compatible endpoint. */
async function fetchCatalog(
  baseURL: string | undefined,
  apiKey: string | undefined,
): Promise<Array<{ id: string; name?: string }>> {
  if (!baseURL && !apiKey) return [];
  const targetUrl = baseURL
    ? `${baseURL.replace(/\/+$/, "")}/models`
    : "https://api.openai.com/v1/models";
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(targetUrl, {
    headers,
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    data?: Array<{ id: string; name?: string; owned_by?: string }>;
  };
  if (!Array.isArray(json.data)) return [];
  return json.data
    .filter(
      (m) =>
        typeof m.id === "string" &&
        m.id.trim().length > 0 &&
        !CHAT_UNSUPPORTED.test(m.id),
    )
    .map((m) => ({ id: m.id.trim(), name: m.name?.trim() || prettifyId(m.id) }));
}

export async function GET(): Promise<Response> {
  const env = envStatus();
  const defaultModel = env.model;
  const omni = providerEndpoint("omniroute");
  const vercel = providerEndpoint("vercel");
  const omniLabel = env.providers[0]?.label ?? "OmniRoute";

  const seen = new Set<string>();
  const models: ModelOption[] = [];

  const push = (option: ModelOption): void => {
    if (seen.has(option.id)) return;
    seen.add(option.id);
    models.push(option);
  };

  // The active default is always first and always present (OmniRoute).
  push({
    id: defaultModel,
    name: prettifyId(defaultModel),
    description: "Default · automatic routing via OmniRoute",
    provider: omniLabel,
    providerId: "omniroute",
  });

  // Primary (OmniRoute) catalog.
  let omniModels: ModelOption[] = [];
  try {
    const fetched = await fetchCatalog(omni.baseURL, omni.apiKey);
    omniModels = fetched.map((m) => ({
      id: m.id,
      name: m.name || prettifyId(m.id),
      provider: omniLabel,
      providerId: "omniroute",
    }));
  } catch {
    // Unreachable or unauthenticated — fall through to the fallback catalog.
  }
  if (omniModels.length === 0) omniModels = FALLBACK_MODELS;
  for (const model of omniModels) push(model);

  // Vercel AI Gateway (paid) catalog — only when the gateway is configured.
  if (vercel.baseURL && vercel.apiKey) {
    let vercelModels: ModelOption[] = [];
    try {
      const fetched = await fetchCatalog(vercel.baseURL, vercel.apiKey);
      vercelModels = fetched.map((m) => ({
        id: m.id,
        name: m.name || prettifyId(m.id),
        provider: "Vercel",
        providerId: "vercel",
      }));
    } catch {
      // Gateway reachable but listing may be unsupported — curated list below.
    }
    if (vercelModels.length === 0) vercelModels = VERCEL_PAID_MODELS;
    for (const model of vercelModels) push(model);
  }

  return Response.json({ default: defaultModel, models });
}
