import { create } from 'zustand';

/**
 * The single-file online demo (`npm run build:demo`) runs inside a sandboxed iframe: downloads,
 * new windows, printing and serial ports are refused there. Those paths check this flag and
 * show an explanation (or an in-app preview) instead of failing silently.
 */
export const IS_DEMO: boolean = import.meta.env.MODE === 'demo';

export interface ReportPreview {
  /** Complete HTML document (already carries the no-script CSP). */
  doc: string;
  /** Opened through "print": the preview says printing is off in the demo. */
  print: boolean;
}

/** Report shown in the in-app preview (demo only); `null` when closed. */
export const useReportPreview = create<{ preview: ReportPreview | null }>(() => ({ preview: null }));

export function showReportPreview(doc: string, print: boolean): void {
  useReportPreview.setState({ preview: { doc, print } });
}

export function closeReportPreview(): void {
  useReportPreview.setState({ preview: null });
}
