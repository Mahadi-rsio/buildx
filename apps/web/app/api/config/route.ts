import { envStatus } from "@buildx/shared";

/** Effective agent configuration for the dashboard (never exposes the key). */
export async function GET(): Promise<Response> {
  const config = envStatus();
  return Response.json({
    hasApiKey: config.hasApiKey,
    model: config.model,
    maxSteps: config.maxSteps,
    baseURL: config.baseURL ?? null,
  });
}
