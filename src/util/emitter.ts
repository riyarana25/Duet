/**
 * Minimal typed event emitter — environment-neutral (no Node `events` dependency), so the
 * client code that uses it runs unchanged in Node and the browser.
 */
export type Listener = (...args: unknown[]) => void;

export class Emitter {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, fn: Listener): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return this;
  }

  once(event: string, fn: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const fn of [...set]) fn(...args);
    return true;
  }
}
