import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import {
  QuotaServiceUnavailableError,
  readConfiguredQuota,
} from "@/lib/quota";

export const dynamic = "force-dynamic";

/**
 * `GET /api/quota` — the caller's authoritative daily AI request budget.
 * The count lives in Upstash Redis; the browser only mirrors this snapshot.
 */
export async function GET(request?: Request): Promise<Response> {
  const user = await getCurrentUser(request?.headers);
  if (!user) return unauthorized();

  try {
    const quota = await readConfiguredQuota(user.id);
    return Response.json(quota);
  } catch (error: unknown) {
    console.error("[GET /api/quota] error:", error);
    if (error instanceof QuotaServiceUnavailableError) {
      return Response.json(
        { error: "quota_service_unavailable", message: error.message },
        { status: 503 },
      );
    }
    return Response.json(
      { error: "internal_error", message: "Unable to read quota." },
      { status: 500 },
    );
  }
}
