// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPORT_CSP, escapeHtml, html, openReportWindow, printReport, rawHtml, reportDocument } from './report';

afterEach(() => vi.restoreAllMocks());

const EVIL = '<img src=x onerror="window.__xss=1">';

describe('report helpers (uygulama #5)', () => {
  it('escapes every interpolated value, keeps nested html', () => {
    expect(escapeHtml(`a&<>"'\``)).toBe('a&amp;&lt;&gt;&quot;&#39;&#96;');
    const rows = ['A', EVIL].map((g) => html`<td>${g}</td>`);
    const out = html`<table><tr>${rows}</tr></table>${null}${rawHtml('<hr>')}`.value;
    expect(out).toBe('<table><tr><td>A</td><td>&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;</td></tr></table><hr>');
    expect(out).not.toContain('<img');
  });

  it('documents carry a no-script CSP and an escaped title', () => {
    const doc = reportDocument(html`<p>${EVIL}</p>`, { title: EVIL, lang: 'en' });
    expect(doc.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(REPORT_CSP).toContain("default-src 'none'");
    expect(REPORT_CSP).not.toContain('script-src');
    expect(doc).not.toContain('<img');
  });

  it('opens a Blob URL without opener', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const create = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    expect(openReportWindow(html`<p>hi</p>`, { title: 't' })).toBe(true);
    expect(open).toHaveBeenCalledWith('blob:x', '_blank', 'noopener,noreferrer');
  });

  it('prints from an iframe sandboxed without allow-scripts, CSP injected into full documents', async () => {
    const p = printReport('<html><head><title>x</title></head><body>hi</body></html>');
    const frame = document.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe('allow-same-origin allow-modals');
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame?.srcdoc).toContain('Content-Security-Policy');
    if (frame?.contentWindow) frame.contentWindow.print = vi.fn();
    frame?.onload?.(new Event('load'));
    await p;
  });
});
