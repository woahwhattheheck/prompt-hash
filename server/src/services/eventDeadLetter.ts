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
  private oldest = 0;

  constructor(maxSize = 1000) {
    if (!Number.isSafeInteger(maxSize) || maxSize < 0) {
      throw new RangeError("maxSize must be a non-negative safe integer");
    }
    this.maxSize = maxSize;
  }

  push(record: DeadLetterRecord): void {
    if (this.maxSize === 0) return;
    if (this.records.length < this.maxSize) {
      this.records.push(record);
      return;
    }
    // Overwrite only the evicted slot; do not shift the whole retained window.
    this.records[this.oldest] = record;
    this.oldest = (this.oldest + 1) % this.maxSize;
  }

  list(): DeadLetterRecord[] {
    return this.oldest === 0
      ? this.records.slice()
      : this.records.slice(this.oldest).concat(this.records.slice(0, this.oldest));
  }

  clear(): void {
    this.records.length = 0;
    this.oldest = 0;
  }

  size(): number {
    return this.records.length;
  }

  byReason(reason: DeadLetterRecord["reason"]): DeadLetterRecord[] {
    const matches: DeadLetterRecord[] = [];
    // Iterate in FIFO order without materializing an intermediate list.
    for (let offset = 0; offset < this.records.length; offset++) {
      const record = this.records[(this.oldest + offset) % this.records.length];
      if (record.reason === reason) matches.push(record);
    }
    return matches;
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
    void Promise.resolve(sink.push(record)).catch((err: unknown) => {
      console.error("[event-dlq] failed to persist dead-letter record", err);
    });
  } catch (err) {
    // Last-resort: never let DLQ plumbing crash the consumer.
    console.error("[event-dlq] failed to persist dead-letter record", err);
  }
}
