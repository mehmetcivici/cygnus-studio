import type { CanFrame, TxFrame } from '../../src/core/frame';
import type { ManualScheduler } from '../../src/transport/scheduler';
import type { Transport, TransportInfo, TransportState } from '../../src/transport/types';

export interface BusNode {
  receive(frame: CanFrame): void;
}

export interface LoggedFrame {
  from: 'host' | 'node';
  frame: CanFrame;
}

/**
 * In-memory CAN bus. Frames are delivered through the scheduler (latency 0 by default), so
 * nothing is re-entrant and tests control delivery by advancing time. Every node sees every
 * frame except its own; hosts see node frames.
 */
export class FakeBus {
  readonly log: LoggedFrame[] = [];
  private readonly nodes = new Set<BusNode>();
  private readonly transports = new Set<FakeTransport>();
  /** Return true to drop a frame on the wire. */
  drop: ((frame: TxFrame, from: 'host' | 'node') => boolean) | null = null;
  /** Extra delivery delay per frame, ms (reordering on purpose: a slow adapter or a busy board). */
  delay: ((frame: TxFrame, from: 'host' | 'node') => number) | null = null;

  constructor(
    readonly scheduler: ManualScheduler,
    readonly latencyMs = 0,
  ) {}

  transport(opts: { fd?: boolean; label?: string } = {}): FakeTransport {
    const t = new FakeTransport(this, { kind: 'sim', label: opts.label ?? 'fake', fd: opts.fd ?? true });
    this.transports.add(t);
    return t;
  }

  attach(node: BusNode): void {
    this.nodes.add(node);
  }

  detach(node: BusNode): void {
    this.nodes.delete(node);
  }

  /** Frames sent by the host(s). */
  hostFrames(): CanFrame[] {
    return this.log.filter((l) => l.from === 'host').map((l) => l.frame);
  }

  fromHost(src: FakeTransport, f: TxFrame): void {
    this.put(f, 'host', src);
  }

  fromNode(src: BusNode, f: TxFrame): void {
    this.put(f, 'node', src);
  }

  private put(f: TxFrame, from: 'host' | 'node', src: unknown): void {
    if (this.drop?.(f, from)) return;
    const frame: CanFrame = { id: f.id, data: f.data.slice(), fd: f.fd, brs: f.brs, timestamp: this.scheduler.now() };
    this.log.push({ from, frame });
    this.scheduler.setTimeout(() => {
      const at: CanFrame = { ...frame, timestamp: this.scheduler.now() };
      for (const n of this.nodes) if (n !== src) n.receive(at);
      for (const t of this.transports) if (t !== src && (!at.fd || t.info.fd)) t.deliver(at);
    }, this.latencyMs + (this.delay?.(f, from) ?? 0));
  }
}

export class FakeTransport implements Transport {
  private readonly frameCbs = new Set<(f: CanFrame) => void>();
  private readonly stateCbs = new Set<(s: TransportState) => void>();
  state: TransportState = { phase: 'closed' };
  sent: TxFrame[] = [];

  constructor(
    private readonly bus: FakeBus,
    readonly info: TransportInfo,
  ) {}

  async open(): Promise<void> {
    this.setState({ phase: 'opening' });
    this.setState({ phase: 'open' });
  }

  async close(): Promise<void> {
    this.setState({ phase: 'closed' });
  }

  /** Simulates an unplugged adapter. */
  fail(error = 'unplugged'): void {
    this.setState({ phase: 'error', error });
  }

  send(frame: TxFrame): void {
    if (this.state.phase !== 'open') return;
    this.sent.push(frame);
    this.bus.fromHost(this, frame);
  }

  onFrame(cb: (f: CanFrame) => void): () => void {
    this.frameCbs.add(cb);
    return () => this.frameCbs.delete(cb);
  }

  onState(cb: (s: TransportState) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  deliver(f: CanFrame): void {
    if (this.state.phase !== 'open') return;
    for (const cb of this.frameCbs) cb(f);
  }

  get listenerCount(): number {
    return this.frameCbs.size + this.stateCbs.size;
  }

  private setState(s: TransportState): void {
    this.state = s;
    for (const cb of this.stateCbs) cb(s);
  }
}

/** Advances time in small steps, letting promise continuations run between steps. */
export async function run(sched: ManualScheduler, ms: number, step = 1): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    sched.advance(Math.min(step, ms - t));
    await flush();
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** Runs time forward until the promise settles (or `maxMs` passes) and returns its outcome. */
export async function settle<T>(sched: ManualScheduler, p: Promise<T>, maxMs = 30_000, step = 1): Promise<T> {
  let done = false;
  const tracked = p.then(
    (v) => {
      done = true;
      return v;
    },
    (e: unknown) => {
      done = true;
      throw e;
    },
  );
  tracked.catch(() => undefined);
  for (let t = 0; t < maxMs && !done; t += step) {
    sched.advance(step);
    await flush();
  }
  return tracked;
}
