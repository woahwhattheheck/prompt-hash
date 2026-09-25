/**
 * In-process dead-letter sink for unsupported / corrupt contract events.
 *
 * Keeps the indexer loop crash-free: callers push decode failures here and
 * continue. Persistence backends (Mongo, file) can wrap this interface later
 * without changing decoder call sites.
 */

import type { DeadLetterRecord } from "./eventDecoder";

export interface EventDeadLetterSink {
  push(record: DeadLetterRecord): Promise<void> | void;
  list(): Promise<DeadLetterRecord[]> | DeadLetterRecord[];
  clear(): Promise<void> | void;
  size(): number;
}

export class InMemoryEventDeadLetter implements EventDeadLetterSink {
  private readonly records: DeadLetterRecord[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  push(record: DeadLetterRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxSize) {
      this.records.splice(0, this.records.length - this.maxSize);
    }
  }

  list(): DeadLetterRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records.length = 0;
  }

  size(): number {
    return this.records.length;
  }

  byReason(reason: DeadLetterRecord["reason"]): DeadLetterRecord[] {
    return this.records.filter((r) => r.reason === reason);
  }
}

/** Shared default sink for unit tests and local indexer wiring. */
export const defaultEventDeadLetter = new InMemoryEventDeadLetter();

/**
 * Route a decode failure into the sink. Never throws.
 */
export function routeToDeadLetter(
  record: DeadLetterRecord,
  sink: EventDeadLetterSink = defaultEventDeadLetter,
): void {
  try {
    void sink.push(record);
  } catch (err) {
    // Last-resort: never let DLQ plumbing crash the consumer.
    console.error("[event-dlq] failed to persist dead-letter record", err);
  }
}
