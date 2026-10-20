/**
 * Model → context-window metadata used to render live context stats.
 *
 * This is a normalized substring catalog of token windows from vendor model
 * cards. Model ids reach Buildx through LiteLLM (`litellm/<id>`), OpenRouter
 * (`<provider>/<id>`), or the `auto` alias, so we strip known provider
 * prefixes and match the remaining id. There is deliberately no catch-all
 * fallback: an unknown model reports no limit rather than a guessed one.
 */

type Rule = { tokens: number; matches: (id: string) => boolean };

const RULES: Rule[] = [
  // Anthropic Claude 3.x / 3.x-sonnet-opus-haiku / 4.x / 5.x: 200k window.
  // Covers both `claude-3-5-sonnet-*` and the newer `claude-sonnet-4-5` naming.
  {
    tokens: 200_000,
    matches: (id) =>
      /^claude-[2-9]/.test(id) || /^claude-(sonnet|opus|haiku)-/.test(id),
  },
  // OpenAI o-series and GPT-5 reasoning models: 200k (400k in select cases,
  // so report the base window the catalog majority exposes).
  {
    tokens: 200_000,
    matches: (id) => /^(o\d|gpt-5|gpt-5\.1|gpt-5\.2)/.test(id),
  },
  // GPT-4o / 4o-mini: 128k.
  { tokens: 128_000, matches: (id) => /^gpt-4o(-mini)?/.test(id) },
  // GPT-4.1 (all variants): 1M.
  { tokens: 1_000_000, matches: (id) => /^gpt-4\.1/.test(id) },
  // GPT-4 / 4-turbo: 128k for turbo, 8k for base.
  { tokens: 128_000, matches: (id) => /^gpt-4-turbo/.test(id) },
  { tokens: 8_192, matches: (id) => /^gpt-4($|-(32k|0613))/.test(id) },
  // GPT-3.5: 16k.
  { tokens: 16_384, matches: (id) => /^gpt-3\.5/.test(id) },
  // Gemini 1.5/2.0/2.5/3: 1M.
  { tokens: 1_000_000, matches: (id) => /^gemini-(1\.5|2|3)/.test(id) },
  // DeepSeek v3 / r1 / chat: 128k.
  { tokens: 128_000, matches: (id) => /^deepseek/.test(id) },
  // Llama 3.x / 4.x (Groq/Anthropic-hosted variants included): 128k.
  { tokens: 128_000, matches: (id) => /^llama-[34]/.test(id) },
  // Mistral / Codestral / Ministral: 128k (Codestral 256k in newer releases).
  { tokens: 128_000, matches: (id) => /^(mistral|codestral|ministral)/.test(id) },
  // Qwen2.5 / Qwen3: 128k.
  { tokens: 128_000, matches: (id) => /^qwen/.test(id) },
  // Grok-2 / Grok-3 / Grok-4: 128k (131_072).
  { tokens: 131_072, matches: (id) => /^grok/.test(id) },
  // Amazon Nova: 128k base.
  { tokens: 128_000, matches: (id) => /^nova-(lite|micro|pro)/.test(id) },
  // x1 / MiniMax / Kimi / GLM: 128k.
  {
    tokens: 128_000,
    matches: (id) => /^(x1|minimax|kimi|glm)/.test(id),
  },
];

/** Provider prefixes the routers prepend; removed before matching. */
const PREFIX = /^(openai|anthropic|google|gemini|groq|deepseek|mistral|meta-llama|meta|qwen|liquid|cohere|x-ai|xai|amazon|microsoft|together|fireworks|ours|recursal|perplexity|nvidia|ibm|baidu|zhipu|moonshot|thetis|ai21|ministral|codestral|litellm)\//;

/** Largest upstream window reported for the model id, or `null` if unknown. */
export function getModelContextWindow(model: string | undefined): number | null {
  if (!model) return null;
  const id = model.trim().toLowerCase().replace(PREFIX, "");
  if (id.length === 0) return null;
  for (const rule of RULES) {
    if (rule.matches(id)) return rule.tokens;
  }
  return null;
}