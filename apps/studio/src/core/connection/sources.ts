/// <reference types="w3c-web-serial" />

/** Where the bus comes from. Only the serialisable fields are remembered between sessions. */
export type ConnectionSource =
  | { kind: 'sim'; scenarioId: string; seed?: number }
  /** `port` is a granted Web Serial port; without one the browser chooser is shown (needs a click). */
  | { kind: 'webserial'; port?: SerialPort; label?: string }
  | { kind: 'tauri-serial'; path: string; baud?: number; label?: string }
  | { kind: 'roborio'; host: string; port?: number };

export type ConnectionKind = ConnectionSource['kind'];

/** JSON-safe form kept in localStorage. */
export type StoredSource =
  | { kind: 'sim'; scenarioId: string }
  | { kind: 'webserial'; label?: string }
  | { kind: 'tauri-serial'; path: string; baud?: number; label?: string }
  | { kind: 'roborio'; host: string; port?: number };

/** Scenario that starts on first launch and always in the demo build. */
export const DEMO_SCENARIO_ID = 'all.devices';
export const DEFAULT_ROBORIO_HOST = '172.22.11.2';
export const ROBORIO_PORT = 5800;
export const DEFAULT_SERIAL_BAUD = 115200;
/** Fixed seed: the same scenario always produces the same UIDs, so saved projects match it again. */
export const SIM_SEED = 1;

export function toStored(s: ConnectionSource): StoredSource {
  switch (s.kind) {
    case 'sim':
      return { kind: 'sim', scenarioId: s.scenarioId };
    case 'webserial':
      return s.label ? { kind: 'webserial', label: s.label } : { kind: 'webserial' };
    case 'tauri-serial':
      return { kind: 'tauri-serial', path: s.path, ...(s.baud ? { baud: s.baud } : {}), ...(s.label ? { label: s.label } : {}) };
    case 'roborio':
      return { kind: 'roborio', host: s.host, ...(s.port ? { port: s.port } : {}) };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function isStoredSource(v: unknown): v is StoredSource {
  if (!isRecord(v)) return false;
  switch (v.kind) {
    case 'sim':
      return typeof v.scenarioId === 'string';
    case 'webserial':
      return v.label === undefined || typeof v.label === 'string';
    case 'tauri-serial':
      return typeof v.path === 'string';
    case 'roborio':
      return typeof v.host === 'string';
    default:
      return false;
  }
}
