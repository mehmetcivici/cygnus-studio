// Dependency-free SVG line charts: the printable report embeds them, and the Bode view uses
// them for its logarithmic frequency axis.

export interface SvgSeries {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  color: string;
  label?: string;
  width?: number;
  dash?: string;
  /** Draw dots instead of a line (measured frequency points). */
  dots?: boolean;
}

export interface SvgChartOptions {
  width: number;
  height: number;
  series: readonly SvgSeries[];
  xLog?: boolean;
  xLabel?: string;
  yLabel?: string;
  /** Fixed y range; auto otherwise. */
  yRange?: [number, number];
  /** Horizontal reference lines (e.g. −180°, 0 dB). */
  hLines?: Array<{ y: number; color: string; dash?: string }>;
  /** Vertical markers (e.g. crossover frequencies). */
  vLines?: Array<{ x: number; color: string; label?: string }>;
  colors: { axis: string; grid: string; text: string; bg?: string };
  fontFamily?: string;
  /** Number formatter for tick labels. */
  fmt?: (v: number, digits: number) => string;
  legend?: boolean;
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);
}

let clipSeq = 0;

function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const e = Math.floor(Math.log10(raw));
  const f = raw / 10 ** e;
  const m = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return m * 10 ** e;
}

export function svgLineChart(o: SvgChartOptions): string {
  const fmt = o.fmt ?? ((v: number, d: number) => v.toFixed(d));
  const padL = 52;
  const padR = 12;
  const padT = o.legend ? 22 : 10;
  const padB = o.xLabel ? 34 : 22;
  const W = o.width;
  const H = o.height;
  const pw = W - padL - padR;
  const ph = H - padT - padB;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const s of o.series) {
    for (let i = 0; i < s.x.length; i++) {
      const x = s.x[i]!;
      const y = s.y[i]!;
      if (!Number.isFinite(x) || !Number.isFinite(y) || (o.xLog && x <= 0)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0)) {
    x0 = o.xLog ? 1 : 0;
    x1 = o.xLog ? 10 : 1;
  }
  if (x1 <= x0) x1 = x0 + (o.xLog ? x0 * 10 : 1);
  if (o.yRange) [y0, y1] = o.yRange;
  if (!Number.isFinite(y0)) {
    y0 = 0;
    y1 = 1;
  }
  if (y1 <= y0) {
    const pad = Math.abs(y0) * 0.1 || 1;
    y0 -= pad;
    y1 += pad;
  } else if (!o.yRange) {
    const pad = (y1 - y0) * 0.06;
    y0 -= pad;
    y1 += pad;
  }
  const lx0 = o.xLog ? Math.log10(x0) : x0;
  const lx1 = o.xLog ? Math.log10(x1) : x1;
  const sx = (x: number): number => padL + (((o.xLog ? Math.log10(x) : x) - lx0) / (lx1 - lx0)) * pw;
  const sy = (y: number): number => padT + (1 - (y - y0) / (y1 - y0)) * ph;
  const font = escapeXml(o.fontFamily ?? 'Lato, Arial, sans-serif');
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${font}" font-size="10">`);
  if (o.colors.bg) parts.push(`<rect width="${W}" height="${H}" fill="${o.colors.bg}"/>`);
  // Y grid.
  const yStep = niceStep(y1 - y0, Math.max(3, Math.floor(ph / 32)));
  const yd = Math.max(0, Math.min(6, -Math.floor(Math.log10(yStep) + 1e-9)));
  for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1 + 1e-9 * yStep; v += yStep) {
    const y = sy(v).toFixed(1);
    parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${o.colors.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 6}" y="${y}" dy="3.5" text-anchor="end" fill="${o.colors.axis}">${escapeXml(fmt(v, yd))}</text>`);
  }
  // X grid.
  if (o.xLog) {
    for (let e = Math.floor(lx0); e <= Math.ceil(lx1); e++) {
      for (const m of [1, 2, 5]) {
        const v = m * 10 ** e;
        if (v < x0 * 0.999 || v > x1 * 1.001) continue;
        const x = sx(v).toFixed(1);
        parts.push(`<line x1="${x}" x2="${x}" y1="${padT}" y2="${padT + ph}" stroke="${o.colors.grid}" stroke-width="${m === 1 ? 1 : 0.5}"/>`);
        parts.push(`<text x="${x}" y="${padT + ph + 13}" text-anchor="middle" fill="${o.colors.axis}">${escapeXml(fmt(v, Math.max(0, -e)))}</text>`);
      }
    }
  } else {
    const xStep = niceStep(x1 - x0, Math.max(3, Math.floor(pw / 70)));
    const xd = Math.max(0, Math.min(6, -Math.floor(Math.log10(xStep) + 1e-9)));
    for (let v = Math.ceil(x0 / xStep) * xStep; v <= x1 + 1e-9 * xStep; v += xStep) {
      const x = sx(v).toFixed(1);
      parts.push(`<line x1="${x}" x2="${x}" y1="${padT}" y2="${padT + ph}" stroke="${o.colors.grid}" stroke-width="1"/>`);
      parts.push(`<text x="${x}" y="${padT + ph + 13}" text-anchor="middle" fill="${o.colors.axis}">${escapeXml(fmt(v, xd))}</text>`);
    }
  }
  for (const h of o.hLines ?? []) {
    if (h.y < y0 || h.y > y1) continue;
    const y = sy(h.y).toFixed(1);
    parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${h.color}" stroke-width="1" stroke-dasharray="${h.dash ?? '4 3'}"/>`);
  }
  for (const v of o.vLines ?? []) {
    if (!Number.isFinite(v.x) || v.x < x0 || v.x > x1) continue;
    const x = sx(v.x).toFixed(1);
    parts.push(`<line x1="${x}" x2="${x}" y1="${padT}" y2="${padT + ph}" stroke="${v.color}" stroke-width="1" stroke-dasharray="3 3"/>`);
    if (v.label) parts.push(`<text x="${x}" y="${padT + 10}" dx="4" fill="${v.color}">${escapeXml(v.label)}</text>`);
  }
  parts.push(`<rect x="${padL}" y="${padT}" width="${pw}" height="${ph}" fill="none" stroke="${o.colors.grid}"/>`);
  // Unique id: several charts share one document (report, Bode pair).
  const cid = `tclip${++clipSeq}`;
  parts.push(`<clipPath id="${cid}"><rect x="${padL}" y="${padT}" width="${pw}" height="${ph}"/></clipPath>`);
  parts.push(`<g clip-path="url(#${cid})">`);
  for (const s of o.series) {
    if (s.dots) {
      for (let i = 0; i < s.x.length; i++) {
        const x = s.x[i]!;
        const y = s.y[i]!;
        if (!Number.isFinite(x) || !Number.isFinite(y) || (o.xLog && x <= 0)) continue;
        parts.push(`<circle cx="${sx(x).toFixed(1)}" cy="${sy(y).toFixed(1)}" r="2.2" fill="${s.color}"/>`);
      }
      continue;
    }
    let d = '';
    let pen = false;
    // Light decimation: skip points closer than half a pixel.
    let lastX = -Infinity;
    for (let i = 0; i < s.x.length; i++) {
      const x = s.x[i]!;
      const y = s.y[i]!;
      if (!Number.isFinite(x) || !Number.isFinite(y) || (o.xLog && x <= 0)) {
        pen = false;
        continue;
      }
      const px = sx(x);
      if (pen && px - lastX < 0.5 && i !== s.x.length - 1) continue;
      d += `${pen ? 'L' : 'M'}${px.toFixed(1)} ${sy(y).toFixed(1)}`;
      pen = true;
      lastX = px;
    }
    if (d) parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 1.5}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round"/>`);
  }
  parts.push('</g>');
  if (o.xLabel) parts.push(`<text x="${padL + pw / 2}" y="${H - 4}" text-anchor="middle" fill="${o.colors.text}" font-weight="700">${escapeXml(o.xLabel)}</text>`);
  if (o.yLabel) parts.push(`<text transform="translate(11 ${padT + ph / 2}) rotate(-90)" text-anchor="middle" fill="${o.colors.text}" font-weight="700">${escapeXml(o.yLabel)}</text>`);
  if (o.legend) {
    let lx = padL;
    for (const s of o.series) {
      if (!s.label) continue;
      parts.push(`<line x1="${lx}" x2="${lx + 14}" y1="9" y2="9" stroke="${s.color}" stroke-width="2"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`);
      parts.push(`<text x="${lx + 18}" y="12" fill="${o.colors.text}">${escapeXml(s.label)}</text>`);
      lx += 26 + s.label.length * 5.6;
    }
  }
  parts.push('</svg>');
  return parts.join('');
}
