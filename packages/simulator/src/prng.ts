/**
 * Seeded PRNG (mulberry32). Every random decision in the simulator goes through one of
 * these so a run is reproducible from its seed.
 */
export class Prng {
  private state: number;
  private spare = 0;
  private hasSpare = false;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Standard normal sample (Box–Muller, second value cached). */
  gauss(): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    this.hasSpare = true;
    return r * Math.cos(2 * Math.PI * v);
  }

  /** Derives an independent generator, so adding a node does not shift other nodes' streams. */
  fork(salt: number): Prng {
    return new Prng((Math.imul(this.int(0x7fffffff) ^ salt, 0x85ebca6b) >>> 0) ^ 0x5bd1e995);
  }

  bytes(n: number): Uint8Array {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = this.int(256);
    return b;
  }
}
