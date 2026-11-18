// localStorage can throw (privacy mode, disabled storage, quota) and is absent in
// some test environments; preferences must never crash the app.

export function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Preference is simply not persisted.
  }
}

export function readStoredJson<T>(key: string, guard: (v: unknown) => v is T): T | null {
  const raw = readStored(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
