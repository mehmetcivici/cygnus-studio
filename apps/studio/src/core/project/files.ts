/**
 * Save/open through the browser primitives (anchor download, hidden file input). Both work in
 * Chromium, Firefox, Safari and the Tauri webview without extra permissions or plugins.
 */
export function downloadFile(name: string, data: string | Uint8Array | Blob, mime = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : new Uint8Array(data)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some engines.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Opens the system file chooser. Resolves with the file, or null when the user cancels
 * (detected through window focus returning without a change event).
 */
export function pickFile(accept = ''): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const done = (f: File | null): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(f);
    };
    const onFocus = (): void => {
      // The change event fires after focus returns; give it a moment.
      setTimeout(() => done(input.files?.[0] ?? null), 400);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    window.addEventListener('focus', onFocus, { once: true });
    input.click();
  });
}

/** `My robot!` → `My-robot`; keeps Turkish letters, drops path separators. */
export function safeFileName(name: string, fallback = 'cygnus'): string {
  const s = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return s || fallback;
}
