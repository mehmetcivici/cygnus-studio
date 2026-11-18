import type { ByteStream } from '@cygnus/protocol';

/** Mirrors `SerialPortEntry` in `src-tauri/crates/cygnus-link` (camelCase on the wire). */
export interface SerialPortInfo {
  path: string;
  kind: 'usb' | 'pci' | 'bluetooth' | 'unknown';
  vid: number | null;
  pid: number | null;
  manufacturer: string | null;
  product: string | null;
  serialNumber: string | null;
}

interface ClosedPayload {
  id: number;
  error: string | null;
}

const CLOSED_EVENT = 'link://closed';
const ID_HEADER = 'x-link-id';
const DEFAULT_TCP_TIMEOUT_MS = 3000;

/** True only inside the Tauri webview; safe to call in a plain browser. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Dynamic imports keep the web build free of Tauri runtime code paths and make this module
// harmless to import in a browser or in tests.
async function tauriCore() {
  if (!isTauri()) throw new Error('Tauri runtime is not available (running in a browser)');
  return import('@tauri-apps/api/core');
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const { invoke } = await tauriCore();
  return invoke<SerialPortInfo[]>('link_list_serial');
}

export function openSerialStream(path: string, baud: number): Promise<ByteStream> {
  return openLink('link_open_serial', { path, baud });
}

export function openTcpStream(host: string, port: number, timeoutMs = DEFAULT_TCP_TIMEOUT_MS): Promise<ByteStream> {
  return openLink('link_open_tcp', { host, port, timeoutMs });
}

// One global listener serves every link. A loss can be announced before the open command's
// reply reaches us, so unmatched events are parked until the stream registers its id.
const closeHandlers = new Map<number, (error?: string) => void>();
const earlyCloses = new Map<number, string | undefined>();
let closedListener: Promise<unknown> | null = null;

function ensureClosedListener(): Promise<unknown> {
  closedListener ??= import('@tauri-apps/api/event').then(({ listen }) =>
    listen<ClosedPayload>(CLOSED_EVENT, ({ payload }) => {
      const error = payload.error ?? undefined;
      const handler = closeHandlers.get(payload.id);
      if (handler) {
        closeHandlers.delete(payload.id);
        handler(error);
      } else {
        earlyCloses.set(payload.id, error);
      }
    }),
  );
  return closedListener;
}

async function openLink(command: string, args: Record<string, unknown>): Promise<ByteStream> {
  const { invoke, Channel } = await tauriCore();
  await ensureClosedListener();

  let dataCb: ((chunk: Uint8Array) => void) | null = null;
  // Chunks that arrive before the consumer subscribes are kept so no byte is lost.
  const backlog: Uint8Array[] = [];
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (buf) => {
    const chunk = new Uint8Array(buf);
    if (dataCb) dataCb(chunk);
    else backlog.push(chunk);
  };

  const id = await invoke<number>(command, { ...args, onData: channel });

  let closed = false;
  let closeCb: ((error?: string) => void) | null = null;
  let closedError: string | undefined;
  const markClosed = (error?: string) => {
    closed = true;
    closedError = error;
    closeCb?.(error);
  };
  if (earlyCloses.has(id)) {
    const error = earlyCloses.get(id);
    earlyCloses.delete(id);
    markClosed(error);
  } else {
    closeHandlers.set(id, markClosed);
  }

  return {
    async write(bytes: Uint8Array): Promise<void> {
      await invoke('link_write', bytes, { headers: { [ID_HEADER]: String(id) } });
    },
    onData(cb) {
      dataCb = cb;
      for (const chunk of backlog.splice(0)) cb(chunk);
    },
    onClose(cb) {
      closeCb = cb;
      if (closed) cb(closedError);
    },
    async close(): Promise<void> {
      closeHandlers.delete(id);
      if (closed) return;
      closed = true;
      await invoke('link_close', { id });
    },
  };
}
