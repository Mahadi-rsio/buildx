import { envStatus } from "@buildx/shared";

export const dynamic = "force-dynamic";

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  provider?: string;
}

/**
 * Fallback catalog used only when the upstream `/models` endpoint cannot be
 * reached. The active default (from `AGENT_MODEL`) is always injected first, so
 * the picker never advertises a model that the server would reject.
 */
const FALLBACK_MODELS: ModelOption[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek Chat (V3)",
    description: "Fast general intelligence & coding",
    provider: "DeepSeek",
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner (R1)",
    description: "Deep chain-of-thought reasoning",
    provider: "DeepSeek",
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    description: "High-intelligence flagship multimodal model",
    provider: "OpenAI",
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    description: "Fast, cost-efficient everyday model",
    provider: "OpenAI",
  },
  {
    id: "claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet",
    description: "Specialized in software engineering",
    provider: "Anthropic",
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

function providerFor(id: string, baseURL?: string): string {
  if (id.includes("/")) return id.split("/")[0] ?? "remote";
  if (baseURL?.includes("deepseek")) return "DeepSeek";
  if (baseURL?.includes("openrouter")) return "OpenRouter";
  if (baseURL?.includes("ai-gateway")) return "Vercel";
  return "Remote";
}

const CHAT_UNSUPPORTED = /(embedding|whisper|tts|dall-e|moderation|image-)/i;

export async function GET(): Promise<Response> {
  const env = envStatus();
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const baseURL = env.baseURL?.trim();
  const defaultModel = env.model;

  let fetchedModels: ModelOption[] = [];

  // Best-effort: fetch the live catalog from the OpenAI-compatible /models API.
  if (apiKey || baseURL) {
    try {
      const targetUrl = baseURL
        ? `${baseURL.replace(/\/+$/, "")}/models`
        : "https://api.openai.com/v1/models";

      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const res = await fetch(targetUrl, {
        headers,
        signal: AbortSignal.timeout(4000),
      });

      if (res.ok) {
        const json = (await res.json()) as {
          data?: Array<{ id: string; name?: string; owned_by?: string }>;
        };
        if (Array.isArray(json.data)) {
          fetchedModels = json.data
            .filter(
              (m) =>
                typeof m.id === "string" &&
                m.id.trim().length > 0 &&
                !CHAT_UNSUPPORTED.test(m.id),
            )
            .map((m) => ({
              id: m.id.trim(),
              name: m.name?.trim() || prettifyId(m.id.trim()),
              provider: m.owned_by || providerFor(m.id.trim(), baseURL),
            }));
        }
      }
    } catch {
      // Unreachable or unauthenticated — fall through to the fallback catalog.
    }
  }

  const seen = new Set<string>();
  const models: ModelOption[] = [];

  const push = (option: ModelOption): void => {
    if (seen.has(option.id)) return;
    seen.add(option.id);
    models.push(option);
  };

  // The active default is always first and always present.
  push({
    id: defaultModel,
    name: prettifyId(defaultModel),
    description: "Default · configured via AGENT_MODEL",
    provider: providerFor(defaultModel, baseURL),
  });

  for (const model of fetchedModels) push(model);
  for (const model of FALLBACK_MODELS) push(model);

  return Response.json({ default: defaultModel, models });
}
