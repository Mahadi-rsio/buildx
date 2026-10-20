import { z } from "zod";

/** RFC 7230 token characters (no separators, no control characters). */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** Visible ASCII + tab + obs-text; rejects CR/LF header injection. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** Framing/hop-by-hop headers must stay under the transport's control. */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
]);

const headersSchema = z.record(
  z
    .string()
    .min(1)
    .max(256)
    .refine((name) => HEADER_NAME.test(name), "invalid header name")
    .refine(
      (name) => !FORBIDDEN_HEADERS.has(name.toLowerCase()),
      "header is managed by the transport",
    ),
  z
    .string()
    .max(8192)
    .refine((value) => HEADER_VALUE.test(value), "invalid header value"),
);

const urlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "url must be an absolute http(s) URL");

export const mcpServerCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  url: urlSchema,
  headers: headersSchema.optional(),
  enabled: z.boolean().optional(),
  allowPrivate: z.boolean().optional(),
  /** Marketplace catalog id, when installed from a curated entry. */
  catalogId: z.string().trim().min(1).max(80).optional(),
});

export const mcpServerUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    url: urlSchema.optional(),
    headers: headersSchema.optional(),
    enabled: z.boolean().optional(),
    allowPrivate: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "no fields to update");

export type McpServerCreateInput = z.infer<typeof mcpServerCreateSchema>;
export type McpServerUpdateInput = z.infer<typeof mcpServerUpdateSchema>;

/** Turn a ZodError into the first human-readable issue. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "invalid request";
}

/** Drop blank header names/values; `undefined` means "no auth headers". */
export function cleanHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.trim(), value.trim()] as const)
    .filter(([name, value]) => name !== "" && value !== "");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The private-host escape hatch is opt-in per deployment. Letting users flip it
 * from the UI would turn the MCP client into an SSRF proxy for internal hosts.
 */
export function privateHostsAllowed(): boolean {
  return process.env.MCP_ALLOW_PRIVATE_HOSTS === "true";
}

/**
 * True when the error is Postgres `42P01 undefined_table` — i.e. the deployment
 * has not applied the `mcp_servers` migration. Surfaces an actionable message
 * instead of a bare relation-does-not-exist stack trace.
 */
export function isMissingTableError(error: unknown): boolean {
  const candidate = (() => {
    if (error && typeof error === "object") {
      const direct = error as { code?: unknown; message?: unknown };
      if (direct.code !== undefined) return error;
      // neon-http / drizzle wrap driver errors; dig one level for code/message.
      const nested = (error as { cause?: unknown }).cause;
      if (nested && typeof nested === "object") return nested;
    }
    return error;
  })();
  if (!candidate || typeof candidate !== "object") return false;
  const code = (candidate as { code?: unknown }).code;
  if (code === "42P01") return true;
  const message = String((candidate as { message?: unknown }).message ?? "");
  return /relation ["']?[^"']*["']? does not exist|undefined_table/i.test(message);
}

/** Standard 503 payload when the `mcp_servers` migration has not been applied. */
export function schemaNotMigrated(): Response {
  return Response.json(
    {
      error: "schema_not_migrated",
      message:
        "The MCP servers table is missing — this deployment has not applied the " +
        "MCP migration. Run `pnpm db:migrate` (or deploy the DB migration) and try again.",
    },
    { status: 503 },
  );
}
