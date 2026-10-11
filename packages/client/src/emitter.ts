/** Minimal typed event emitter that works in the browser and Node. */
export class Emitter<Events extends Record<string, unknown[]>> {
  private readonly listeners: { [E in keyof Events]?: Set<(...args: Events[E]) => void> } = {};

  on<E extends keyof Events>(event: E, fn: (...args: Events[E]) => void): () => void {
    (this.listeners[event] ??= new Set()).add(fn);
    return () => this.listeners[event]?.delete(fn);
  }

  protected emit<E extends keyof Events>(event: E, ...args: Events[E]): void {
    for (const fn of this.listeners[event] ?? []) fn(...args);
  }
}
