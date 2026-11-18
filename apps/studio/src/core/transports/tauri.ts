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

const OPEN_RETRIES = 3;
const OPEN_RETRY_MS = 150;

async function openLink(command: string, args: Record<string, unknown>): Promise<ByteStream> {
  const { invoke, Channel } = await tauriCore();
  await ensureClosedListener();
  // The previous link to this port may still be releasing its exclusive lock (the shell closes
  // stale links itself, but an OS driver can lag): retry briefly before giving up.
  let lastError: unknown;
  for (let attempt = 0; attempt <= OPEN_RETRIES; attempt++) {
    try {
      return await openLinkOnce(invoke, Channel, command, args);
    } catch (e) {
      lastError = e;
      if (!/lock|busy|denied/i.test(String(e)) || attempt === OPEN_RETRIES) break;
      await new Promise((r) => setTimeout(r, OPEN_RETRY_MS * (attempt + 1)));
    }
  }
  throw lastError;
}

type TauriCore = Awaited<ReturnType<typeof tauriCore>>;

async function openLinkOnce(invoke: TauriCore['invoke'], Channel: TauriCore['Channel'], command: string, args: Record<string, unknown>): Promise<ByteStream> {
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

  // Every invoke is its own task in Tauri's async runtime: two un-awaited writes may reach the
  // port in either order (a neutral frame overtaken by the last setpoint). Chain them.
  let tail: Promise<void> = Promise.resolve();
  return {
    write(bytes: Uint8Array): Promise<void> {
      const next = tail.then(() => invoke<void>('link_write', bytes, { headers: { [ID_HEADER]: String(id) } }));
      // A failed write must not wedge the queue; the caller still sees its own rejection.
      tail = next.catch(() => undefined);
      return next;
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
      // After queued writes (a final neutral frame must still go out), then wait for the
      // shell to release the port before resolving.
      await tail;
      await invoke('link_close', { id });
    },
  };
}
