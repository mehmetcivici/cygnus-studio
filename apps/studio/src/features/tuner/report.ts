import { fmtNumber, fmtValue, t, type Lang } from '../../i18n';
import { REPORT_CSP, escapeHtml } from '../../core';
import type { GainRole } from '@cygnus/protocol';
import { svgLineChart } from './svg';
import { headline, runLabelKey } from './runs';
import { ROLE_SYMBOL } from './loop';
import { NOT_REACHED_PCT, stepScore, type StepMetrics } from './analysis/step';
import type { TunerRun } from './types';
import { tTuner } from './messages';

export interface ReportInput {
  lang: Lang;
  title: string;
  deviceName: string;
  modelName: string;
  loopName: string;
  unit: string;
  roles: readonly GainRole[];
  runs: readonly TunerRun[];
  notes: string;
  projectName: string;
}

// Print palette: fixed colors that survive black-and-white printing reasonably.
const PALETTE = ['#1f6feb', '#d1242f', '#1a7f37', '#8250df', '#bc4c00', '#0a7a8a', '#9a6700', '#57606a'];
const COLORS = { axis: '#57606a', grid: '#d0d7de', text: '#24292f', bg: '#ffffff' };

/**
 * Self-contained, print-ready tuning report (charts embedded as SVG).
 *
 * Runs come from project files that teams share, so every value that is not app-authored
 * markup goes through `esc` — numbers too, because a hand-edited file can put anything where a
 * number belongs. The document also carries the core's no-script CSP as a second fence.
 */
export function buildReport(r: ReportInput): string {
  const L = r.lang;
  const tr = (k: Parameters<typeof tTuner>[0], p?: Record<string, string | number>): string => t(tTuner.key(k), p, L);
  const esc = escapeHtml;
  const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);
  const n = (v: unknown, d: number): string => esc(fmtNumber(num(v), d, { lang: L, grouping: false }));
  const fv = (v: unknown, u: string, d: number): string => esc(fmtValue(num(v), u, d, { lang: L }));
  // Time metrics of a response that never reached the target are not shown (see gradeStep).
  const ok = (m: StepMetrics): boolean => !m.noResponse && m.steadyErrorPct < NOT_REACHED_PCT;
  const tm = (m: StepMetrics, s: string): string => (ok(m) ? s : '—');
  const tag = (x: TunerRun): string => `#${esc(x.n)}${x.gainSet ? ` (${esc(x.gainSet)})` : ''}`;
  const fmt = (v: number, d: number): string => fmtNumber(v, d, { lang: L, grouping: false });
  const date = new Date().toLocaleString(L === 'tr' ? 'tr-TR' : 'en-US');
  const closed = r.runs.filter((x) => headline(x));
  let best: TunerRun | null = null;
  for (const x of closed) if (!best || stepScore(headline(x)!) < stepScore(headline(best)!)) best = x;

  const parts: string[] = [];
  parts.push(`<!DOCTYPE html><html lang="${L}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${esc(REPORT_CSP)}"><meta name="referrer" content="no-referrer"><title>${esc(r.title)}</title><style>
  @page { size: A4; margin: 14mm; }
  body { font-family: Lato, "Segoe UI", Arial, sans-serif; color: #24292f; margin: 0; font-size: 11px; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 18px; }
  h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 14px; margin: 18px 0 6px; border-bottom: 1px solid #d0d7de; padding-bottom: 3px; }
  h3 { font-size: 12px; margin: 12px 0 4px; }
  .meta { color: #57606a; margin-bottom: 10px; } .meta span { margin-right: 14px; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0 8px; font-variant-numeric: tabular-nums; }
  th, td { border-bottom: 1px solid #eaeef2; padding: 3px 6px; text-align: right; } th { color: #57606a; font-weight: 700; }
  th:first-child, td:first-child { text-align: left; }
  .run { break-inside: avoid; page-break-inside: avoid; }
  .best { background: #fff8c5; } .note { color: #57606a; font-style: italic; }
  .toolbar { position: sticky; top: 0; background: #f6f8fa; border-bottom: 1px solid #d0d7de; padding: 8px 18px; color: #57606a; }
  @media print { .toolbar { display: none; } .wrap { padding: 0; } }
  svg { display: block; max-width: 100%; height: auto; }
</style></head><body>`);
  parts.push(`<div class="toolbar">${esc(tr('report.printHint'))}</div><div class="wrap">`);
  parts.push(`<h1>${esc(r.title)}</h1>`);
  parts.push(
    `<div class="meta"><span>${esc(tr('report.device'))}: <b>${esc(r.deviceName)}</b> (${esc(r.modelName)})</span><span>${esc(tr('report.loop'))}: <b>${esc(r.loopName)}</b></span><span>${esc(date)}</span>${r.projectName ? `<span>${esc(tr('report.project'))}: ${esc(r.projectName)}</span>` : ''}</div>`,
  );

  if (closed.length) {
    parts.push(`<h2>${esc(tr('report.summary'))}</h2>`);
    parts.push(
      svgLineChart({
        width: 720,
        height: 240,
        colors: COLORS,
        fmt,
        legend: true,
        xLabel: tr('report.time'),
        yLabel: r.unit,
        series: closed.flatMap((x, i) => [
          { x: x.data.t, y: x.data.target, color: PALETTE[i % PALETTE.length]!, dash: '5 3', width: 1 },
          { x: x.data.t, y: x.data.measured, color: PALETTE[i % PALETTE.length]!, label: `#${x.n}${x.gainSet ? ` (${x.gainSet})` : ''}`, width: 1.6 },
        ]),
      }),
    );
    const pid = r.roles.filter((g) => g === 'kp' || g === 'ki' || g === 'kd');
    parts.push(`<table><thead><tr><th>#</th>${pid.map((g) => `<th>${esc(ROLE_SYMBOL[g] ?? g)}</th>`).join('')}<th>${esc(tr('m.riseTime'))}</th><th>${esc(tr('m.overshoot'))}</th><th>${esc(tr('m.settlingTime'))}</th><th>${esc(tr('m.steadyErrorShort'))}</th><th>IAE</th><th>ζ</th><th>${esc(tr('m.saturationShort'))}</th></tr></thead><tbody>`);
    for (const x of closed) {
      const m = headline(x)!;
      parts.push(
        `<tr class="${x === best ? 'best' : ''}"><td>${tag(x)}${x === best ? ' ★' : ''}</td>${pid.map((g) => `<td>${n(x.gains[g], 5)}</td>`).join('')}<td>${tm(m, fv(m.riseTime, 's', 3))}</td><td>${tm(m, fv(m.overshoot, '%', 1))}</td><td>${tm(m, Number.isNaN(m.settlingTime) ? esc(tr('metrics.notSettled')) : fv(m.settlingTime, 's', 3))}</td><td>${fv(m.steadyErrorPct, '%', 2)}</td><td>${tm(m, n(m.iae, 4))}</td><td>${tm(m, n(m.damping, 2))}</td><td>${fv(m.saturation, '%', 0)}</td></tr>`,
      );
    }
    parts.push('</tbody></table>');
    if (best) parts.push(`<p>${esc(tr('report.bestIs', { n: best.n }))}</p>`);
  }

  for (const x of r.runs) {
    parts.push(`<div class="run"><h2>${tag(x)} · ${esc(tr(runLabelKey(x)))}</h2>`);
    parts.push(`<div class="meta"><span>${esc(new Date(x.createdAt).toLocaleString(L === 'tr' ? 'tr-TR' : 'en-US'))}</span><span>${esc(tr('report.stream', { hz: fmtNumber(1e6 / num(x.periodUs), 0, { lang: L }), lost: num(x.lost) }))}</span></div>`);
    parts.push(`<table><thead><tr>${r.roles.map((g) => `<th>${esc(ROLE_SYMBOL[g] ?? g)}</th>`).join('')}</tr></thead><tbody><tr>${r.roles.map((g) => `<td>${n(x.gains[g], 6)}</td>`).join('')}</tr></tbody></table>`);
    parts.push(
      svgLineChart({
        width: 720,
        height: 200,
        colors: COLORS,
        fmt,
        legend: true,
        yLabel: x.unit,
        series: [
          { x: x.data.t, y: x.data.target, color: '#57606a', dash: '5 3', label: tr('sig.target'), width: 1 },
          { x: x.data.t, y: x.data.measured, color: PALETTE[0]!, label: tr('sig.measured'), width: 1.6 },
        ],
      }),
    );
    parts.push(
      svgLineChart({
        width: 720,
        height: 120,
        colors: COLORS,
        fmt,
        legend: true,
        xLabel: tr('report.time'),
        yLabel: x.outputUnit,
        series: [{ x: x.data.t, y: x.data.output, color: PALETTE[1]!, label: tr('sig.output'), width: 1.2 }],
      }),
    );
    const m = headline(x);
    if (m) {
      const rows: Array<[string, string]> = [
        [tr('m.riseTime'), tm(m, fv(m.riseTime, 's', 3))],
        [tr('m.peakTime'), tm(m, fv(m.peakTime, 's', 3))],
        [tr('m.overshoot'), tm(m, fv(m.overshoot, '%', 1))],
        [tr('m.settlingTime'), tm(m, Number.isNaN(m.settlingTime) ? esc(tr('metrics.notSettled')) : fv(m.settlingTime, 's', 3))],
        [tr('m.steadyError'), `${fv(m.steadyError, x.unit, 4)} (${fv(m.steadyErrorPct, '%', 2)})`],
        ['IAE / ITAE', tm(m, `${n(m.iae, 4)} / ${n(m.itae, 4)}`)],
        [tr('m.damping'), tm(m, n(m.damping, 2))],
        [tr('m.saturation'), fv(m.saturation, '%', 1)],
        [tr('m.noiseRms'), fv(m.noiseRms, x.unit, 4)],
      ];
      parts.push(`<table><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</tbody></table>`);
    }
    const a = x.analysis;
    if (a.ff) parts.push(`<h3>${esc(tr('ff.title'))}</h3><p>kS = ${n(a.ff.kS, 4)}, kV = ${n(a.ff.kV, 6)}, kA = ${n(a.ff.kA, 6)}, R² = ${n(a.ff.r2, 4)}</p>`);
    if (a.model)
      parts.push(
        `<h3>${esc(tr('id.title'))}</h3><p>${esc(tr(a.model.model.kind === 'fopdt' ? 'id.fopdt' : 'id.integrating'))}: K = ${n(a.model.model.K, 4)}, τ = ${fv(a.model.model.tau, 's', 4)}, θ = ${fv(a.model.model.theta, 's', 4)}, R² = ${n(a.model.r2, 4)}</p>`,
      );
    if (a.relay) parts.push(`<h3>${esc(tr('relay.title'))}</h3><p>Ku = ${n(a.relay.ku, 4)}, Tu = ${fv(a.relay.tu, 's', 3)}, a = ${n(a.relay.a, 5)}</p>`);
    if (a.bode) {
      const b = a.bode;
      parts.push(`<h3>${esc(tr('freq.title'))}</h3>`);
      parts.push(
        svgLineChart({ width: 720, height: 170, colors: COLORS, fmt, legend: true, xLog: true, yLabel: 'dB', hLines: [{ y: 0, color: '#bc4c00' }], series: [{ x: b.f, y: b.loopDb, color: PALETTE[0]!, label: tr('bode.loop'), width: 1.6 }, { x: b.f, y: b.closedDb, color: PALETTE[2]!, label: tr('bode.closed'), dash: '5 3' }] }),
      );
      parts.push(
        svgLineChart({ width: 720, height: 170, colors: COLORS, fmt, legend: false, xLog: true, xLabel: tr('bode.freq'), yLabel: '°', hLines: [{ y: -180, color: '#bc4c00' }], series: [{ x: b.f, y: b.loopDeg, color: PALETTE[0]!, width: 1.6 }, { x: b.f, y: b.closedDeg, color: PALETTE[2]!, dash: '5 3' }] }),
      );
      parts.push(`<p>${esc(tr('freq.pm'))}: ${fv(b.margins.phaseMarginDeg, '°', 1)} · ${esc(tr('freq.gm'))}: ${Number.isFinite(b.margins.gainMarginDb) ? fv(b.margins.gainMarginDb, 'dB', 1) : '∞'}</p>`);
    }
    if (x.note) parts.push(`<p class="note">${esc(x.note)}</p>`);
    parts.push('</div>');
  }
  if (r.notes.trim()) parts.push(`<h2>${esc(tr('report.notes'))}</h2><p>${esc(r.notes).replace(/\n/g, '<br>')}</p>`);
  parts.push(`<p class="meta">${esc(tr('report.footer'))}</p></div></body></html>`);
  return parts.join('');
}
