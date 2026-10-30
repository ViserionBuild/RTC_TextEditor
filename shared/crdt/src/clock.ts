/** Lamport logical clock. */
export class LamportClock {
  constructor(private current = 0) {}

  get value(): number {
    return this.current;
  }

  /** Advance for a local event and return the new timestamp. */
  tick(): number {
    return ++this.current;
  }

  /** Merge a timestamp observed on a remote event. */
  observe(remote: number): void {
    if (remote > this.current) this.current = remote;
  }
}
