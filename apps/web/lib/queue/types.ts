export interface RunDispatchMessage {
  runId: string;
  idempotencyKey?: string | null;
  step?: number;
  outboxId?: string;
  attempt?: number;
  correlationId?: string;
}
