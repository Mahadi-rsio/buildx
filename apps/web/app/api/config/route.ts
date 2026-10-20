import { envStatus } from "@buildx/shared";

/** Effective agent configuration for the dashboard (never exposes the key). */
export async function GET(): Promise<Response> {
  const config = envStatus();
  return Response.json({
    hasApiKey: config.hasApiKey,
    model: config.model,
    maxSteps: config.maxSteps,
    allowPrivateMcpHosts: process.env.MCP_ALLOW_PRIVATE_HOSTS === "true",
    baseURL: config.baseURL ?? null,
    defaultProvider:
      config.providers.find((provider) => provider.primary)?.id ??
      config.providers.find((provider) => provider.hasApiKey)?.id ??
      "litellm",
    providers: config.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      baseURL: provider.baseURL ?? null,
      hasApiKey: provider.hasApiKey,
      primary: provider.primary,
    })),
  });
}
