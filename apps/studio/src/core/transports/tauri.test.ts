// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const pending: Array<() => void> = [];
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: ((b: ArrayBuffer) => void) | null = null;
  },
  invoke: vi.fn((cmd: string, args: unknown) => {
    if (cmd === 'link_open_serial') return Promise.resolve(7);
    if (cmd === 'link_write') {
      calls.push(`write:${Array.from(args as Uint8Array).join(',')}`);
      return new Promise<void>((r) => pending.push(r));
    }
    calls.push(cmd);
    return Promise.resolve();
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

describe('Tauri link writes (uygulama #11)', () => {
  it('issues one link_write at a time, in order, and closes after the queue drains', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    const { openSerialStream } = await import('./tauri');
    const s = await openSerialStream('/dev/ttyACM0', 115200);
    const a = s.write(new Uint8Array([1]));
    const b = s.write(new Uint8Array([2]));
    const closing = s.close();
    await Promise.resolve();
    expect(calls).toEqual(['write:1']);
    pending.shift()?.();
    await a;
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['write:1', 'write:2']);
    pending.shift()?.();
    await b;
    await closing;
    expect(calls).toEqual(['write:1', 'write:2', 'link_close']);
  });
});
