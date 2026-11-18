import { IS_DEMO, showReportPreview } from '../demo/demo';
/**
 * Printable reports without giving report content any power over the app.
 *
 * Report HTML is assembled from user data (project files are shared between teams), so:
 * - every interpolated value is escaped (`html` template / `escapeHtml`);
 * - the document carries a CSP that forbids all scripts, even if escaping is forgotten;
 * - it opens either as a Blob URL in a `noopener` window (no `window.opener`) or in a hidden
 *   iframe sandboxed WITHOUT `allow-scripts`, so nothing in it can execute.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(/[&<>"'`]/g, (c) => ESCAPES[c] ?? c);
}

/** Pre-escaped markup; only `html`/`rawHtml` create it. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Marks trusted, app-authored markup (never user data) as safe to embed. */
export function rawHtml(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

function part(v: unknown): string {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false) return '';
  return escapeHtml(v);
}

/**
 * Auto-escaping template: ``html`<td>${device.name}</td>` `` escapes `device.name`;
 * nested `html` results and arrays of them are embedded as-is.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += part(v) + (strings[i + 1] ?? '');
  });
  return new SafeHtml(out);
}

/** CSP of every report document: no scripts, no network; inline styles and data images only. */
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";

export interface ReportDocOptions {
  title: string;
  lang?: string;
  /** App-authored CSS (not user data). */
  css?: string;
}

/** Wraps a report body into a complete, script-proof HTML document. */
export function reportDocument(body: SafeHtml, opts: ReportDocOptions): string {
  return (
    '<!DOCTYPE html>' +
    html`<html lang="${opts.lang ?? 'tr'}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${opts.title}</title><style>${rawHtml(opts.css ?? '')}</style></head><body>${body}</body></html>`.value
  );
}

function asDocument(doc: string | SafeHtml, opts?: ReportDocOptions): string {
  if (doc instanceof SafeHtml) return reportDocument(doc, opts ?? { title: '' });
  // A full document string: make sure the no-script CSP is the first thing in <head>.
  const meta = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`;
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${meta}</head><body>${doc}</body></html>`;
}

/**
 * Opens the report in a new tab/window as a Blob URL with `noopener,noreferrer`: the page has no
 * `window.opener`, and its CSP blocks scripts. The user prints with the browser (Ctrl+P).
 * Returns false when there is no `window` (tests). Pop-up blockers cannot be detected with
 * `noopener` (the call always returns null), so call it from a click handler.
 */
export function openReportWindow(doc: string | SafeHtml, opts?: ReportDocOptions): boolean {
  if (typeof window === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  if (IS_DEMO) {
    showReportPreview(asDocument(doc, opts), false);
    return true;
  }
  const url = URL.createObjectURL(new Blob([asDocument(doc, opts)], { type: 'text/html;charset=utf-8' }));
  window.open(url, '_blank', 'noopener,noreferrer');
  // The new page loads asynchronously; keep the URL long enough for slow machines.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/**
 * Prints the report from a hidden iframe sandboxed without `allow-scripts` (works where new
 * windows are blocked, e.g. the desktop shell). Resolves after the print dialog was opened.
 */
export function printReport(doc: string | SafeHtml, opts?: ReportDocOptions): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  if (IS_DEMO) {
    showReportPreview(asDocument(doc, opts), true);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    // allow-same-origin only lets the app call print(); without allow-scripts nothing runs inside.
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    frame.srcdoc = asDocument(doc, opts);
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } finally {
        window.setTimeout(() => frame.remove(), 1000);
        resolve();
      }
    };
    document.body.appendChild(frame);
  });
}
