/** Shared detection for the daily model-request ceiling. */

export function isDailyLimitMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return /daily ai request limit/i.test(message);
}

export function dailyLimitResetLabel(resetAt: number | undefined): string {
  if (!resetAt || !Number.isFinite(resetAt)) {
    return "midnight Asia/Dhaka";
  }
  return new Date(resetAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Dhaka",
    timeZoneName: "short",
  });
}
