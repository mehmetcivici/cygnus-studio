import { describe, expect, it } from 'vitest';
import { Model } from '@cygnus/protocol';
import { emptyProject } from '../../core';
import { buildReport } from './report';
import { reportHtml } from './ReportTab';

describe('project report HTML (kaçış)', () => {
  it('escapes names from a crafted project file and carries the no-script CSP', () => {
    const p = emptyProject('x', '0.1.0', new Date('2026-11-01T10:00:00Z'));
    p.name = '<img src=x onerror="window.__xss=1">';
    p.notes = '<script>alert(1)</script>';
    p.bus = { capturedAt: '2026-11-01T10:05:00.000Z', devices: [{ uid48: '0123456789ab', driver: 'cycan', model: Model.ESC_80A, modelKey: 'esc80a', devType: 2, num: 1, name: '<svg onload=alert(1)>', fw: '1.0.0', params: {} }] };
    const html = reportHtml(buildReport(p, 'tr', { appVersion: 't' }), p.name, 'tr');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<svg onload');
    expect(html).toContain('&lt;img');
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="[^"]*default-src/);
  });
});
