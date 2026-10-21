/** Demo-only credit wallet. No payment provider is contacted. */

export const MIN_TOP_UP_BDT = 100;
export const REQUESTS_PER_TAKA = 2;

const STORAGE_KEY = "buildx.credits.bdt";

export function readCreditBalance(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeCreditBalance(value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Private mode: the in-memory result still updates the dialog.
  }
}

export function normalizeTopUp(amount: number): number {
  if (!Number.isFinite(amount)) return MIN_TOP_UP_BDT;
  return Math.max(MIN_TOP_UP_BDT, Math.floor(amount));
}

export function requestsForAmount(amount: number): number {
  return normalizeTopUp(amount) * REQUESTS_PER_TAKA;
}

export function formatTaka(amount: number): string {
  return `৳${Math.round(amount).toLocaleString("en-US")}`;
}

/**
 * Mock top-up: validates the minimum, waits ~1s, then grows the local wallet.
 * Swap this for a real payment intent when billing lands.
 */
export async function createTopUp(
  amount: number,
): Promise<{ amount: number; balance: number; requests: number }> {
  const normalized = normalizeTopUp(amount);
  if (normalized < MIN_TOP_UP_BDT) {
    throw new Error(`Minimum top-up is ${formatTaka(MIN_TOP_UP_BDT)}.`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const balance = readCreditBalance() + normalized;
  writeCreditBalance(balance);
  return {
    amount: normalized,
    balance,
    requests: normalized * REQUESTS_PER_TAKA,
  };
}
