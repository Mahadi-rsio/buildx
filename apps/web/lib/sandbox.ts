import { DaemonSandbox, LocalSandbox, type Sandbox } from "@buildx/sandbox";

export interface SandboxSettings {
  kind: "local" | "remote";
  baseUrl?: string;
  token?: string;
}

/**
 * Resolve how runs execute. Local mode shells out on this machine (dev/tests).
 * Remote mode talks to the sandbox-daemon on a Fly Machine via
 * `SANDBOX_BASE_URL` + `SANDBOX_TOKEN`.
 */
export function sandboxSettings(): SandboxSettings {
  const baseUrl = (process.env.SANDBOX_BASE_URL ?? "").trim();
  const token = (process.env.SANDBOX_TOKEN ?? "").trim();
  if (baseUrl && token) return { kind: "remote", baseUrl, token };
  return { kind: "local" };
}

/** Build the sandbox that backs a run's workspace. */
export function createSandbox(workspaceDir: string): Sandbox {
  const settings = sandboxSettings();
  if (settings.kind === "remote") {
    return new DaemonSandbox({
      baseUrl: settings.baseUrl as string,
      token: settings.token as string,
    });
  }
  return new LocalSandbox({ rootDir: workspaceDir });
}