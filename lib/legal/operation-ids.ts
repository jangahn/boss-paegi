export type OperationIdFactory = () => string;

type PendingOperation = {
  fingerprint: string;
  operationId: string;
};

/**
 * Keeps one operation UUID for an uncertain request until its exact response
 * is known. Changing the payload creates a new logical operation; retrying the
 * same payload reuses the receipt key.
 */
export class LegalOperationIds {
  private readonly pending = new Map<string, PendingOperation>();
  private readonly createId: OperationIdFactory;

  constructor(createId: OperationIdFactory = () => crypto.randomUUID()) {
    this.createId = createId;
  }

  get(slot: string, payload: Record<string, unknown>): string {
    const fingerprint = JSON.stringify(payload);
    const current = this.pending.get(slot);
    if (current?.fingerprint === fingerprint) return current.operationId;

    const operationId = this.createId();
    this.pending.set(slot, { fingerprint, operationId });
    return operationId;
  }

  clear(...slots: string[]): void {
    for (const slot of slots) this.pending.delete(slot);
  }

  clearAll(): void {
    this.pending.clear();
  }
}

// The retry contract is generic; keep the original export for the legal editor
// and expose a domain-neutral name for other durable admin mutations.
export { LegalOperationIds as RetryOperationIds };
