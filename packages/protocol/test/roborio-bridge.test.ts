import { describe, expect, it } from 'vitest';
import type { CanFrame } from '../src/core/frame';
import { CygnusBus } from '../src/host/bus';
import { CyncoderV3Driver, V3Class, V3Telemetry, v3Id } from '../src/legacy';
import { ManualScheduler } from '../src/transport/scheduler';
import { RoboRioBridgeTransport, isBridgeAllowedId } from '../src/transport/roborio-bridge';
import type { ByteStream } from '../src/transport/slcan-transport';
import { caught } from './helpers/setup';
import { flush, settle } from './helpers/fake-bus';

class FakeSocket implements ByteStream {
  written: Uint8Array[] = [];
  closed = false;
  private dataCb: ((b: Uint8Array) => void) | null = null;
  private closeCb: ((e?: string) => void) | null = null;
  write(bytes: Uint8Array): void {
    this.written.push(bytes.slice());
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
  feed(bytes: ArrayLike<number>): void {
    this.dataCb?.(Uint8Array.from(bytes));
  }
  drop(error?: string): void {
    this.closeCb?.(error);
  }
}

const HELLO_BRIDGE = [0x03, 0x43, 0x59, 0x47, 0x42];
const HELLO_DAEMON = [0x03, 0x43, 0x59, 0x47, 0x44];

const u32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

/** bridge -> host CAN frame message. */
const rxMsg = (id: number, data: number[], ts = 0x01020304): number[] => [0x01, ...u32(id), data.length, ...u32(ts), ...data];

function setup(opts: { helloTimeoutMs?: number } = {}) {
  const sock = new FakeSocket();
  const sched = new ManualScheduler(500);
  const t = new RoboRioBridgeTransport(sock, { scheduler: sched, label: 'roboRIO 10.94.73.2', ...opts });
  const frames: CanFrame[] = [];
  t.onFrame((f) => frames.push(f));
  return { sock, sched, t, frames };
}

describe('RoboRioBridgeTransport', () => {
  it('opens on the hello message and reports which program answered', async () => {
    const a = setup();
    expect(a.t.info).toEqual({ kind: 'roborio-bridge', label: 'roboRIO 10.94.73.2', fd: false });
    const p = a.t.open();
    expect(a.t.currentState.phase).toBe('opening');
    a.sock.feed(HELLO_BRIDGE);
    await p;
    expect(a.t.currentState.phase).toBe('open');
    expect(a.t.peer).toBe('bridge');

    const b = setup();
    const pb = b.t.open();
    b.sock.feed(HELLO_DAEMON);
    await pb;
    expect(b.t.peer).toBe('daemon');
  });

  it('accepts a hello that arrived before open()', async () => {
    const a = setup();
    a.sock.feed(HELLO_BRIDGE);
    await a.t.open();
    expect(a.t.currentState.phase).toBe('open');
  });

  it('fails open() when no hello arrives in time', async () => {
    const a = setup({ helloTimeoutMs: 800 });
    const p = caught(a.t.open());
    a.sched.advance(799);
    expect(a.t.currentState.phase).toBe('opening');
    a.sched.advance(1);
    expect(String(await p)).toContain('hello');
    expect(a.t.currentState).toMatchObject({ phase: 'error' });
  });

  it('rejects a bad hello id', async () => {
    const a = setup();
    const p = caught(a.t.open());
    a.sock.feed([0x03, 0x58, 0x58, 0x58, 0x58]);
    expect(String(await p)).toContain('hello id');
  });

  it('decodes received frames: big-endian id, size, ignored timestamp, payload', async () => {
    const a = setup();
    a.sock.feed(HELLO_BRIDGE);
    await a.t.open();
    const id = v3Id(V3Class.TELEMETRY, V3Telemetry.DEVICE_UID, 15);
    a.sock.feed(rxMsg(id, [0xcd, 0xab, 0x34, 0x12]));
    a.sock.feed(rxMsg(id, [])); // empty payload is legal
    expect(a.frames).toHaveLength(2);
    expect(a.frames[0]).toMatchObject({ id, fd: false, brs: false, timestamp: 500 });
    expect([...(a.frames[0] as CanFrame).data]).toEqual([0xcd, 0xab, 0x34, 0x12]);
    expect(a.frames[1]?.data.length).toBe(0);
  });

  it('survives any split of the byte stream, and glued messages', async () => {
    const id1 = v3Id(V3Class.TELEMETRY, 0, 1);
    const id2 = v3Id(V3Class.TELEMETRY, 1, 2);
    const stream = [...HELLO_BRIDGE, ...rxMsg(id1, [1, 2, 3, 4, 5, 6, 7, 8]), ...rxMsg(id2, [9, 8]), ...rxMsg(id1, [])];
    // Every chunk size from 1 byte up to the whole stream.
    for (let size = 1; size <= stream.length; size++) {
      const a = setup();
      const p = a.t.open();
      for (let i = 0; i < stream.length; i += size) a.sock.feed(stream.slice(i, i + size));
      await p;
      expect(a.frames.map((f) => [f.id, [...f.data]])).toEqual([
        [id1, [1, 2, 3, 4, 5, 6, 7, 8]],
        [id2, [9, 8]],
        [id1, []],
      ]);
    }
  });

  it('drops remote/11-bit flagged frames but keeps parsing', async () => {
    const a = setup();
    a.sock.feed(HELLO_BRIDGE);
    await a.t.open();
    const good = v3Id(V3Class.TELEMETRY, 0, 1);
    a.sock.feed([...rxMsg(0x80000000 | good, [1]), ...rxMsg(0x40000000 | good, [2]), ...rxMsg(good, [3])]);
    expect(a.frames.map((f) => [...f.data])).toEqual([[3]]);
  });

  it('treats an unknown message type or a bogus size as a broken stream', async () => {
    const a = setup();
    a.sock.feed(HELLO_BRIDGE);
    await a.t.open();
    a.sock.feed([0x7f]);
    expect(a.t.currentState).toMatchObject({ phase: 'error' });
    expect(a.t.currentState.error).toContain('0x7f');

    const b = setup();
    b.sock.feed(HELLO_BRIDGE);
    await b.t.open();
    b.sock.feed([0x01, ...u32(1), 9, ...u32(0)]);
    expect(b.t.currentState.error).toContain('size 9');
  });

  it('encodes sent frames as 0x02 + id + size + payload, and only for Cyncoder commands', async () => {
    const a = setup();
    a.sock.feed(HELLO_BRIDGE);
    await a.t.open();
    const cmd = v3Id(V3Class.COMMAND, 3, 15);
    a.t.send({ id: cmd, data: Uint8Array.from([0xcd, 0xab, 0x34, 0x12, 9]), fd: false, brs: false });
    expect(a.sock.written).toHaveLength(1);
    expect([...(a.sock.written[0] as Uint8Array)]).toEqual([0x02, ...u32(cmd), 5, 0xcd, 0xab, 0x34, 0x12, 9]);

    // The bridge refuses anything else, so the transport never sends it: CyCAN ENUM_REQ, telemetry class, FD, other devices.
    a.t.send({ id: (2 << 24) | (8 << 16) | (0x12 << 10), data: new Uint8Array(1), fd: false, brs: false });
    a.t.send({ id: v3Id(V3Class.TELEMETRY, 0, 15), data: new Uint8Array(8), fd: false, brs: false });
    a.t.send({ id: cmd, data: new Uint8Array(12), fd: true, brs: true });
    a.t.send({ id: (10 << 24) | (9 << 16) | (1 << 10), data: new Uint8Array(4), fd: false, brs: false });
    expect(a.sock.written).toHaveLength(1);
    expect(isBridgeAllowedId(cmd)).toBe(true);
    expect(isBridgeAllowedId(cmd | 0x80000000)).toBe(false);
  });

  it('drops sends while not open, reports a lost connection, and closes the stream', async () => {
    const a = setup();
    const cmd = v3Id(V3Class.COMMAND, 0, 1);
    a.t.send({ id: cmd, data: new Uint8Array(4), fd: false, brs: false });
    expect(a.sock.written).toHaveLength(0);
    a.sock.feed(HELLO_BRIDGE);
    await a.t.open();
    const states: string[] = [];
    a.t.onState((s) => states.push(s.phase));
    a.sock.drop('connection reset');
    expect(states).toEqual(['error']);
    expect(a.t.currentState.error).toBe('connection reset');

    const b = setup();
    b.sock.feed(HELLO_BRIDGE);
    await b.t.open();
    await b.t.close();
    expect(b.sock.closed).toBe(true);
    expect(b.t.currentState.phase).toBe('closed');
  });

  it('carries a CygnusBus with the legacy driver end to end, without leaking CyCAN traffic', async () => {
    const sock = new FakeSocket();
    const sched = new ManualScheduler();
    const t = new RoboRioBridgeTransport(sock, { scheduler: sched });
    const legacy = new CyncoderV3Driver({ initialSequence: 20 });
    const bus = new CygnusBus(t, sched, { drivers: [legacy] });
    sock.feed(HELLO_BRIDGE);
    await bus.start();
    expect(bus.state.phase).toBe('open');

    const uid = [0xcd, 0xab, 0x34, 0x12];
    sock.feed(rxMsg(v3Id(V3Class.TELEMETRY, V3Telemetry.DEVICE_UID, 5), uid));
    // 90 deg, 60 deg/s
    sock.feed(rxMsg(v3Id(V3Class.TELEMETRY, V3Telemetry.POSITION_VELOCITY, 5), [0, 0, 0xb4, 0x42, 0, 0, 0x70, 0x42]));
    const d = legacy.deviceByUid(0x1234abcd);
    expect(d?.num).toBe(5);
    expect(d?.getSignal('position.deg')).toBe(90);

    const p = d!.command('zero_here');
    await flush();
    // The bus' enumeration broadcast (class 0x12) was filtered out; only the legacy command crossed the wire.
    expect(sock.written).toHaveLength(1);
    const w = sock.written[0] as Uint8Array;
    expect(w[0]).toBe(0x02);
    expect([...w.slice(1, 5)]).toEqual(u32(v3Id(V3Class.COMMAND, 0, 5)));
    expect([...w.slice(6)]).toEqual([...uid, 20]);
    sock.feed(rxMsg(v3Id(V3Class.TELEMETRY, V3Telemetry.COMMAND_ACK, 5), [0, 0, 20, 0, ...uid]));
    expect(await settle(sched, p)).toMatchObject({ confirmed: true });
  });
});
