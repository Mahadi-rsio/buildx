/**
 * Keep this entrypoint runtime-neutral. Next.js bundles instrumentation for
 * both Node.js and Edge, so Node-only worker dependencies must live in the
 * Node-specific module and only be loaded for the Node.js runtime.
 */
export async function register(): Promise<void> {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    !process.env.BUILDX_DISABLE_LOCAL_WORKER
  ) {
    await import("./instrumentation-node");
  }
}
