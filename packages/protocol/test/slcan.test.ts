import { describe, expect, it } from 'vitest';
import {
  ManualScheduler,
  SlcanParser,
  SlcanTransport,
  encodeSlcanCommand,
  encodeSlcanFrame,
  slcanSetupCommands,
  type ByteStream,
  type CanFrame,
  type TransportState,
} from '../src';

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const dec = (b: Uint8Array) => String.fromCharCode(...b);

function collect() {
  const frames: CanFrame[] = [];
  const events: string[] = [];
  const parser = new SlcanParser({
    frame: (f) => frames.push(f),
    ack: () => events.push('ack'),
    nack: () => events.push('nack'),
    txAck: () => events.push('txAck'),
    ignored: () => events.push('ignored'),
    other: (l) => events.push(`other:${l}`),
  });
  return { parser, frames, events };
}

describe('slcan encoder', () => {
  it('classic extended frame', () => {
    const s = dec(encodeSlcanFrame({ id: 0x02084c01, data: Uint8Array.of(0xb3, 0x01, 0xff), fd: false, brs: false }));
    expect(s).toBe('T02084C013B301FF\r');
  });

  it('FD frames use D / B and pad to the DLC length', () => {
    const data = Uint8Array.from({ length: 10 }, (_, i) => i);
    expect(dec(encodeSlcanFrame({ id: 1, data, fd: true, brs: false }))).toBe(`D000000019${'00010203040506070809'}0000\r`);
    expect(dec(encodeSlcanFrame({ id: 1, data: new Uint8Array(64), fd: true, brs: true })).slice(0, 10)).toBe('B00000001F');
  });

  it('rejects impossible frames', () => {
    expect(() => encodeSlcanFrame({ id: 0x20000000, data: new Uint8Array(0), fd: false, brs: false })).toThrow(RangeError);
    expect(() => encodeSlcanFrame({ id: 1, data: new Uint8Array(9), fd: false, brs: false })).toThrow(RangeError);
    expect(() => encodeSlcanFrame({ id: 1, data: new Uint8Array(65), fd: true, brs: true })).toThrow(RangeError);
  });

  it('setup commands', () => {
    expect(slcanSetupCommands(0)).toEqual(['C', 'S8', 'O']);
    expect(slcanSetupCommands(5)).toEqual(['C', 'S8', 'Y5', 'O']);
    expect(dec(encodeSlcanCommand('S8'))).toBe('S8\r');
  });
});

describe('slcan parser', () => {
  it('parses classic and FD frames, case-insensitive hex', () => {
    const { parser, frames } = collect();
    parser.push(enc('T02084c013B301ff\rB0000000190001020304050607080900bb\r'), 42);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ id: 0x02084c01, data: Uint8Array.of(0xb3, 1, 0xff), fd: false, brs: false, timestamp: 42 });
    expect(frames[1]!.fd).toBe(true);
    expect(frames[1]!.brs).toBe(true);
    expect(frames[1]!.data.length).toBe(12);
    expect(frames[1]!.data[11]).toBe(0xbb);
  });

  it('reassembles frames split across arbitrary chunks', () => {
    const { parser, frames } = collect();
    const wire = enc('T1FFFFFFF80102030405060708\rD020848019' + '11'.repeat(12) + '\r\r');
    for (let i = 0; i < wire.length; i += 3) parser.push(wire.subarray(i, i + 3), i);
    expect(frames.map((f) => f.id)).toEqual([0x1fffffff, 0x02084801]);
    expect(frames[0]!.timestamp).toBe(24); // stamped when the CR arrived
    expect(frames[1]!.data).toEqual(new Uint8Array(12).fill(0x11));
  });

  it('byte-by-byte delivery yields the same result', () => {
    const { parser, frames } = collect();
    for (const c of enc('T0000000120102\r')) parser.push(Uint8Array.of(c), 0);
    expect(frames[0]!.data).toEqual(Uint8Array.of(1, 2));
  });

  it('reports acks, errors, tx acks and ignores 11-bit / remote frames', () => {
    const { parser, frames, events } = collect();
    parser.push(enc('\r\x07z\rZ\rt1232AABB\rR000000010\rV1013\r'), 0);
    expect(frames).toHaveLength(0);
    expect(events).toEqual(['ack', 'nack', 'txAck', 'txAck', 'ignored', 'ignored', 'other:V1013']);
  });

  it('accepts an optional timestamp, rejects malformed lines and recovers', () => {
    const { parser, frames, events } = collect();
    parser.push(enc('T000000011AA1234\rT0000000G1AA\rT000000019AA\rT00000001\r'), 0);
    parser.push(enc(`T${'0'.repeat(300)}\rT000000010\r`), 0);
    expect(frames.map((f) => f.data.length)).toEqual([1, 0]);
    expect(events).toEqual(['other:T0000000G1AA', 'other:T000000019AA', 'other:T00000001', 'other:<overlong line>']);
  });

  it('BEL mid-line discards the partial line', () => {
    const { parser, frames, events } = collect();
    parser.push(enc('T0000\x07T000000010\r'), 0);
    expect(events).toEqual(['nack']);
    expect(frames).toHaveLength(1);
  });
});

class FakePort implements ByteStream {
  written: string[] = [];
  closed = false;
  private dataCb: ((b: Uint8Array) => void) | null = null;
  private closeCb: ((e?: string) => void) | null = null;
  autoReply: ((line: string) => string | null) | null = () => '\r';

  write(bytes: Uint8Array): void {
    const s = dec(bytes);
    this.written.push(s);
    const r = this.autoReply?.(s);
    if (r) this.feed(r);
  }
  onData(cb: (b: Uint8Array) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: (e?: string) => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.closed = true;
  }
  feed(s: string): void {
    this.dataCb?.(enc(s));
  }
  unplug(): void {
    this.closeCb?.('device lost');
  }
}

describe('SlcanTransport', () => {
  it('opens with the setup sequence, then sends and receives frames', async () => {
    const port = new FakePort();
    const sched = new ManualScheduler(1000);
    const t = new SlcanTransport(port, { scheduler: sched, dataBitrate: 2, label: 'CANable' });
    const states: TransportState[] = [];
    t.onState((s) => states.push(s));
    await t.open();
    expect(port.written).toEqual(['C\r', 'S8\r', 'Y2\r', 'O\r']);
    expect(states.map((s) => s.phase)).toEqual(['opening', 'open']);
    expect(t.info).toEqual({ kind: 'slcan', label: 'CANable', fd: true });

    port.autoReply = null;
    t.send({ id: 0x00084800, data: Uint8Array.of(0), fd: false, brs: false });
    expect(port.written.at(-1)).toBe('T0008480010' + '0\r');

    const got: CanFrame[] = [];
    const off = t.onFrame((f) => got.push(f));
    sched.advance(5);
    port.feed('T02084C0182233000000000000\r');
    expect(got).toHaveLength(1);
    expect(got[0]!.timestamp).toBe(1005);
    off();
    port.feed('T02084C0182233000000000000\r');
    expect(got).toHaveLength(1);

    await t.close();
    expect(port.written.at(-1)).toBe('C\r');
    expect(port.closed).toBe(true);
    expect(t.currentState.phase).toBe('closed');
  });

  it('a rejected initial C is fine (channel already closed)', async () => {
    const port = new FakePort();
    port.autoReply = (l) => (l === 'C\r' ? '\x07' : '\r');
    const t = new SlcanTransport(port, { scheduler: new ManualScheduler(), dataBitrate: 0 });
    await t.open();
    expect(t.currentState.phase).toBe('open');
    expect(t.info.fd).toBe(false);
    // FD frames cannot go out on a classic link.
    const n = port.written.length;
    t.send({ id: 1, data: new Uint8Array(12), fd: true, brs: true });
    expect(port.written.length).toBe(n);
  });

  it('fails when the adapter rejects a setup command', async () => {
    const port = new FakePort();
    port.autoReply = (l) => (l === 'Y2\r' ? '\x07' : '\r');
    const t = new SlcanTransport(port, { scheduler: new ManualScheduler() });
    await expect(t.open()).rejects.toThrow(/rejected 'Y2'/);
    expect(t.currentState).toEqual({ phase: 'error', error: "adapter rejected 'Y2'" });
  });

  it('times out on a silent adapter using the scheduler', async () => {
    const port = new FakePort();
    port.autoReply = null;
    const sched = new ManualScheduler();
    const t = new SlcanTransport(port, { scheduler: sched, openTimeoutMs: 500 });
    const p = t.open();
    sched.advance(499);
    expect(t.currentState.phase).toBe('opening');
    sched.advance(1);
    await expect(p).rejects.toThrow(/did not answer/);
  });

  it('reports an unplugged port as an error', async () => {
    const port = new FakePort();
    const t = new SlcanTransport(port, { scheduler: new ManualScheduler() });
    await t.open();
    port.unplug();
    expect(t.currentState).toEqual({ phase: 'error', error: 'device lost' });
  });
});
