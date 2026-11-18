import type { CanFrame, Transport, TransportInfo, TransportState } from '@cygnus/protocol';
import type { BusEndpoint, BusFrame } from './bus';
import type { Simulation } from './simulation';

/**
 * Connects a host client to the simulated bus as one more endpoint (like a USB-CAN adapter).
 * Frames the host sends go on the wire at the next simulation step.
 */
export class SimTransport implements Transport, BusEndpoint {
  readonly info: TransportInfo;
  private readonly frameListeners = new Set<(f: CanFrame) => void>();
  private readonly stateListeners = new Set<(s: TransportState) => void>();
  private phase: TransportState['phase'] = 'closed';

  constructor(
    private readonly sim: Simulation,
    label: string,
  ) {
    this.info = { kind: 'sim', label, fd: sim.bus.fd };
  }

  get state(): TransportState {
    return { phase: this.phase };
  }

  async open(): Promise<void> {
    if (this.phase === 'open') return;
    this.setPhase('opening');
    this.sim.bus.attach(this);
    this.setPhase('open');
  }

  async close(): Promise<void> {
    if (this.phase === 'closed') return;
    this.sim.bus.detach(this);
    this.setPhase('closed');
  }

  send(frame: Omit<CanFrame, 'timestamp'>): void {
    if (this.phase !== 'open') return;
    const len = frame.data.length;
    if (frame.id < 0 || frame.id > 0x1fffffff || len > (frame.fd ? 64 : 8)) return;
    this.sim.bus.transmit(this, frame.id, frame.data, len, frame.fd, frame.brs);
  }

  onFrame(cb: (f: CanFrame) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  onState(cb: (s: TransportState) => void): () => void {
    this.stateListeners.add(cb);
    cb(this.state);
    return () => this.stateListeners.delete(cb);
  }

  receive(f: BusFrame): void {
    if (this.frameListeners.size === 0) return;
    const frame: CanFrame = {
      id: f.id,
      data: f.data.slice(0, f.len),
      fd: f.fd,
      brs: f.brs,
      timestamp: this.sim.hostTime(f.timestamp),
    };
    for (const cb of this.frameListeners) cb(frame);
  }

  private setPhase(p: TransportState['phase']): void {
    this.phase = p;
    const s = this.state;
    for (const cb of this.stateListeners) cb(s);
  }
}
