/** Minimal typed event emitter. `has` lets hot paths skip building payloads nobody listens to. */
export class Emitter<E extends object> {
  private readonly listeners = new Map<keyof E, Set<(payload: never) => void>>();

  on<K extends keyof E>(event: K, cb: (payload: E[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as (payload: never) => void);
    return () => {
      set.delete(cb as (payload: never) => void);
    };
  }

  has<K extends keyof E>(event: K): boolean {
    const set = this.listeners.get(event);
    return set !== undefined && set.size > 0;
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const cb of set) (cb as (p: E[K]) => void)(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}
