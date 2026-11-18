import { decodeMessage, idClass, idIndex, idNum, idDevType, type CanFrame, type DecodedMessage, type TxFrame } from '@cygnus/protocol';
import type { Simulation } from '../src/simulation';

export interface Rx {
  frame: CanFrame;
  msg: DecodedMessage | null;
}

/** A host on the simulated bus that records everything it hears. */
export class Host {
  readonly rx: Rx[] = [];
  readonly transport;

  constructor(readonly sim: Simulation) {
    this.transport = sim.createTransport('test');
    void this.transport.open();
    this.transport.onFrame((f) => this.rx.push({ frame: f, msg: decodeMessage(f.id, f.data) }));
  }

  send(f: TxFrame): void {
    this.transport.send(f);
  }

  run(ms: number): void {
    this.sim.advance(ms);
  }

  clear(): void {
    this.rx.length = 0;
  }

  /** Messages of one kind, optionally from one (devType, num). */
  of<K extends DecodedMessage['kind']>(kind: K, from?: { devType: number; num: number }): Array<Extract<DecodedMessage, { kind: K }> & { t: number; id: number }> {
    const out: Array<Extract<DecodedMessage, { kind: K }> & { t: number; id: number }> = [];
    for (const r of this.rx) {
      if (!r.msg || r.msg.kind !== kind) continue;
      if (from && (idDevType(r.frame.id) !== from.devType || (kind !== 'enumRsp' && idNum(r.frame.id) !== from.num))) continue;
      out.push({ ...(r.msg as Extract<DecodedMessage, { kind: K }>), t: r.frame.timestamp, id: r.frame.id });
    }
    return out;
  }

  frames(cls: number, index?: number): CanFrame[] {
    return this.rx.filter((r) => idClass(r.frame.id) === cls && (index === undefined || idIndex(r.frame.id) === index)).map((r) => r.frame);
  }

  last<K extends DecodedMessage['kind']>(kind: K, from?: { devType: number; num: number }): (Extract<DecodedMessage, { kind: K }> & { t: number; id: number }) | undefined {
    const a = this.of(kind, from);
    return a[a.length - 1];
  }

  /** Sends a request, runs `ms`, returns the replies of `kind` that arrived meanwhile. */
  ask<K extends DecodedMessage['kind']>(f: TxFrame, kind: K, ms = 20, from?: { devType: number; num: number }): Array<Extract<DecodedMessage, { kind: K }> & { t: number; id: number }> {
    this.clear();
    this.send(f);
    this.run(ms);
    return this.of(kind, from);
  }
}
