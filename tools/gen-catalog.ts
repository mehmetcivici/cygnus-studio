// Generates docs/CATALOG.md and firmware/cycan/include/cycan_catalog.h from the catalog in
// packages/protocol/src/catalog. Run from the repo root: npx tsx tools/gen-catalog.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG,
  COMMON_COMMANDS,
  COMMON_FAULTS,
  CommonPid,
  DEVICE_STATE_LABELS,
  PType,
  validateCatalog,
  type ModelDef,
  type ParamDef,
} from '../packages/protocol/src';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const issues = validateCatalog();
if (issues.length > 0) {
  for (const i of issues) console.error(`${i.model} ${i.path}: ${i.message}`);
  process.exit(1);
}

const PTYPE_NAME: Record<number, string> = {
  [PType.U32]: 'u32',
  [PType.I32]: 'i32',
  [PType.F32]: 'f32',
  [PType.BOOL]: 'bool',
  [PType.ENUM]: 'enum',
};
const CATEGORY_TR: Record<string, string> = { motor: 'Motor sürücü', sensor: 'Sensör', servo: 'Servo', power: 'Güç', tool: 'Araç' };
const hex = (n: number, w = 4) => `0x${n.toString(16).toUpperCase().padStart(w, '0')}`;
const cell = (s: string) => s.replace(/\|/g, '\\|');

function fmt(n: number, digits?: number): string {
  if (digits !== undefined && !Number.isInteger(n)) return Number(n.toFixed(digits)).toString();
  return Number.isInteger(n) ? n.toString() : Number(n.toPrecision(7)).toString();
}

function paramValue(p: ParamDef, v: number): string {
  if (p.ptype === PType.BOOL) return v ? 'açık' : 'kapalı';
  if (p.ptype === PType.ENUM) return p.options?.find((o) => o.value === v)?.label.tr ?? String(v);
  return fmt(v, p.digits);
}

function paramFlags(p: ParamDef): string {
  const f: string[] = [];
  if (p.readOnly) f.push('salt-okunur');
  if (p.rebootRequired) f.push('yeniden başlatma');
  if (p.lockedWhileEnabled) f.push('sürerken kilitli');
  if (p.advanced) f.push('gelişmiş');
  return f.join(', ');
}

// ---------------------------------------------------------------------------------------
// CATALOG.md

function modelMarkdown(m: ModelDef): string {
  const L: string[] = [];
  L.push(`## ${m.model} · ${m.name.tr}`, '');
  L.push(`${m.description.tr}`, '');
  L.push(`DEVTYPE **${m.devType}** · anahtar \`${m.key}\` · katalog sürümü ${m.catalogRev} · akış en küçük periyodu ${m.stream.minPeriodUs} µs`, '');

  L.push('### Parametreler', '');
  if (m.params.length === 0) L.push('_Yok._', '');
  else {
    const groupName = new Map(m.groups.map((g) => [g.key, g.label.tr]));
    L.push('| pid | Anahtar | Ad | Tip | Birim | Aralık | Varsayılan | Grup | Bayraklar | Açıklama |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const p of m.params) {
      let range = p.ptype === PType.ENUM || p.ptype === PType.BOOL ? '' : `${fmt(p.min, p.digits)} … ${fmt(p.max, p.digits)}`;
      if (p.minNonZero !== undefined) range += ` (0 = kapalı, en az ${fmt(p.minNonZero)})`;
      let help = p.help.tr;
      if (p.options) help += ` Seçenekler: ${p.options.map((o) => `${o.value} ${o.label.tr}`).join(' · ')}.`;
      L.push(
        `| ${hex(p.pid)} | \`${p.key}\` | ${cell(p.label.tr)} | ${PTYPE_NAME[p.ptype]} | ${p.unit} | ${range} | ${cell(paramValue(p, p.default))} | ${cell(groupName.get(p.group) ?? p.group)} | ${paramFlags(p)} | ${cell(help)} |`,
      );
    }
    L.push('');
  }

  L.push('### Sinyaller', '');
  if (m.signals.length === 0) L.push('_Yok._', '');
  else {
    L.push('| sid | Anahtar | Ad | Birim | Gösterim aralığı | Basamak | Değerler |');
    L.push('|---|---|---|---|---|---|---|');
    for (const s of m.signals) {
      const values = s.options
        ? s.options.map((o) => `${o.value} ${o.label.tr}`).join(' · ')
        : s.bits
          ? s.bits.map((b, i) => `bit${i} ${b.tr}`).join(' · ')
          : '';
      L.push(`| ${s.sid} | \`${s.key}\` | ${cell(s.label.tr)} | ${s.unit} | ${fmt(s.range[0])} … ${fmt(s.range[1])} | ${s.digits} | ${cell(values)} |`);
    }
    L.push('');
  }

  L.push('### Durum çerçeveleri', '');
  if (m.statusFrames.length === 0) L.push('_Yok._', '');
  for (const f of m.statusFrames) {
    L.push(`**STATUS/${f.index} · ${f.label.tr}** — varsayılan periyot ${f.defaultPeriodMs} ms (\`status.${f.index}.period_ms\`)`, '');
    L.push('| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |');
    L.push('|---|---|---|---|---|---|---|');
    for (const fd of [...f.fields].sort((a, b) => a.byte - b.byte || (a.bit ?? 0) - (b.bit ?? 0))) {
      const s = m.signals.find((x) => x.key === fd.signal);
      const bits = fd.bits !== undefined ? `${fd.bit ?? 0}..${(fd.bit ?? 0) + fd.bits - 1}` : '';
      L.push(`| ${fd.byte} | ${bits} | ${fd.type} | \`${fd.signal}\` | ${fd.type === 'f32' ? '' : fmt(fd.scale ?? 1)} | ${fd.bias ? fmt(fd.bias) : ''} | ${s?.unit ?? ''} |`);
    }
    L.push('');
  }

  L.push('### Kontrol çerçeveleri', '');
  if (m.controls.length === 0) L.push('_Yok (eyleyici değil)._', '');
  for (const c of m.controls) {
    if (c.format === 'set') {
      L.push(`**CTRL/${c.index} · ${c.label.tr}** — \`[mode u8] [flags u8] [0 0] [value f32]\``, '');
      L.push('| Kip | Anahtar | Ad | Birim | Değer aralığı |');
      L.push('|---|---|---|---|---|');
      for (const md of c.modes ?? []) {
        const range = md.min === md.max ? '—' : `${fmt(md.min)} … ${fmt(md.max)}`;
        L.push(`| ${md.value} | \`${md.key}\` | ${md.label.tr} | ${md.unit} | ${range} |`);
      }
      L.push('');
    } else if (c.format === 'servo4') {
      const a = c.firstChannel ?? 1;
      L.push(`**CTRL/${c.index} · ${c.label.tr}** — \`[u16 µs × 4]\`, kanal ${a}–${a + 3}; 0 = kanal kapalı`, '');
    } else {
      L.push(`**CTRL/${c.index} · ${c.label.tr}** — \`[line u8] [col u8] [6 ASCII]\`; NUL baytları çizilmez`, '');
    }
  }

  L.push('### Eylemler', '');
  if (m.actions.length === 0) L.push('_Yalnızca ortak komutlar._', '');
  else {
    L.push('| Komut | Anahtar | Ad | Argüman | Açıklama |');
    L.push('|---|---|---|---|---|');
    for (const a of m.actions) {
      const arg = a.arg ? `${a.arg.label.tr} (${PTYPE_NAME[a.arg.ptype]}, ${a.arg.unit}, ${fmt(a.arg.min)} … ${fmt(a.arg.max)})` : '';
      const notes = [a.longRunning ? 'uzun süren' : '', a.confirm ? 'onay ister' : ''].filter(Boolean).join(', ');
      L.push(`| ${hex(a.cmd, 2)} | \`${a.key}\` | ${a.label.tr} | ${cell(arg)} | ${cell(a.help.tr)}${notes ? ` _(${notes})_` : ''} |`);
    }
    L.push('');
  }

  L.push('### Modele özgü hatalar', '');
  if (m.faults.length === 0) L.push('_Yok._', '');
  else {
    L.push('| Bit | Anahtar | Ad |', '|---|---|---|');
    for (const f of m.faults) L.push(`| ${f.bit} | \`${f.key}\` | ${f.label.tr} |`);
    L.push('');
  }

  L.push('### Öz-test bitleri', '');
  if (m.selfTestBits.length === 0) L.push('_Yok._', '');
  else {
    L.push('| Bit | Anahtar | Ad |', '|---|---|---|');
    for (const b of m.selfTestBits) L.push(`| ${b.bit} | \`${b.key}\` | ${b.label.tr} |`);
    L.push('');
  }

  if (m.tuner.loops.length > 0) {
    L.push('### Tuner döngüleri', '');
    L.push('| Döngü | Kip | Birim | Kazançlar | Hedef / ölçüm / çıkış / hata |');
    L.push('|---|---|---|---|---|');
    for (const l of m.tuner.loops) {
      const gains = Object.entries(l.gains).map(([r, k]) => `${r}=\`${k}\``).join(' ');
      const sigs = [l.signals.target, l.signals.measured, l.signals.output, l.signals.error].map((s) => `\`${s}\``).join(' / ');
      L.push(`| ${l.label.tr} | CTRL/${l.ctrlFrame} kip ${l.mode} | ${l.unit} | ${gains} | ${sigs} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

function catalogMarkdown(): string {
  const L: string[] = [];
  L.push('# Cygnus cihaz kataloğu', '');
  L.push('> Bu dosya `tools/gen-catalog.ts` tarafından `packages/protocol/src/catalog` kodundan üretilir; elle düzenlemeyin.', '');
  L.push('| Model | Ad | DEVTYPE | Tür | Sürüm | Parametre | Sinyal | Durum çerçevesi | Eylem |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const m of CATALOG) {
    L.push(`| ${m.model} | [${m.name.tr}](#${m.model}--${anchor(m.name.tr)}) | ${m.devType} | ${CATEGORY_TR[m.category]} | ${m.catalogRev} | ${m.params.length} | ${m.signals.length} | ${m.statusFrames.length} | ${m.actions.length} |`);
  }
  L.push('');
  L.push('## Ortak tanımlar', '');
  L.push('Her modele otomatik eklenen ortak parametreler: `can.data_bitrate` (0x0001), `can.termination` (0x0002), eyleyicilerde `ctrl.timeout_ms` (0x0003) ve her durum çerçevesi için `status.n.period_ms` (0x0010+n).', '');
  L.push('**Ortak hata bitleri**', '', '| Bit | Anahtar | Ad |', '|---|---|---|');
  for (const f of COMMON_FAULTS) L.push(`| ${f.bit} | \`${f.key}\` | ${f.label.tr} |`);
  L.push('', '**Ortak komutlar**', '', '| Komut | Anahtar | Ad |', '|---|---|---|');
  for (const c of COMMON_COMMANDS) L.push(`| ${c.cmd} | \`${c.key}\` | ${c.label.tr} |`);
  L.push('', '**Kart durumları**', '', '| Değer | Ad |', '|---|---|');
  for (const [v, t] of Object.entries(DEVICE_STATE_LABELS)) L.push(`| ${v} | ${t.tr} |`);
  L.push('');
  for (const m of CATALOG) L.push(modelMarkdown(m));
  return `${L.join('\n').trimEnd()}\n`;
}

/** GitHub-style heading anchor (lowercase, spaces → '-', punctuation dropped). */
function anchor(s: string): string {
  return s
    .toLocaleLowerCase('tr')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

// ---------------------------------------------------------------------------------------
// cycan_catalog.h

// Comments stay 7-bit ASCII so any embedded toolchain accepts the header.
const ASCII_MAP: Record<string, string> = { 'µ': 'u', '°': 'deg', 'Ω': 'ohm', '²': '^2', '·': '-', '→': '->', '’': "'", '−': '-', '…': '..', '×': 'x' };
const ascii = (s: string) =>
  s
    .replace(/[^\x20-\x7e]/g, (c) => ASCII_MAP[c] ?? '?')
    .replace(/\*\//g, '* /');

const cname = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

function cNum(p: { ptype: number }, v: number): string {
  if (p.ptype === PType.F32) {
    // The shortest decimal of the double rounds to the same f32 in any C compiler.
    const s = Number.isInteger(v) ? `${v}.0` : String(v);
    return `${s.includes('.') || s.includes('e') ? s : `${s}.0`}f`;
  }
  if (p.ptype === PType.I32) return v < 0 ? `(${v})` : `${v}`;
  return `${v}u`;
}

const PTYPE_C: Record<number, string> = {
  [PType.U32]: 'CYCAN_PTYPE_U32',
  [PType.I32]: 'CYCAN_PTYPE_I32',
  [PType.F32]: 'CYCAN_PTYPE_F32',
  [PType.BOOL]: 'CYCAN_PTYPE_BOOL',
  [PType.ENUM]: 'CYCAN_PTYPE_ENUM',
};

function cFlags(p: ParamDef): string {
  const f: string[] = [];
  if (p.readOnly) f.push('CYCAN_PF_READ_ONLY');
  if (p.rebootRequired) f.push('CYCAN_PF_REBOOT');
  if (p.lockedWhileEnabled) f.push('CYCAN_PF_LOCKED_WHILE_ENABLED');
  if (p.advanced) f.push('CYCAN_PF_ADVANCED');
  return f.length ? f.join(' | ') : '0u';
}

function catalogHeader(): string {
  const L: string[] = [];
  const def = (name: string, value: string, comment?: string) =>
    L.push(`#define ${name.padEnd(56)} ${value}${comment ? `  /* ${ascii(comment)} */` : ''}`);

  L.push('/* Generated by tools/gen-catalog.ts from packages/protocol/src/catalog. Do not edit. */');
  L.push('#ifndef CYCAN_CATALOG_H', '#define CYCAN_CATALOG_H', '');
  L.push('/* Parameter types (PROTOCOL 5). */');
  def('CYCAN_PTYPE_U32', '0u');
  def('CYCAN_PTYPE_I32', '1u');
  def('CYCAN_PTYPE_F32', '2u');
  def('CYCAN_PTYPE_BOOL', '3u');
  def('CYCAN_PTYPE_ENUM', '4u');
  L.push('', '/* Parameter flags used by the CYCAN_<MODEL>_PARAMS X-macros. */');
  def('CYCAN_PF_READ_ONLY', '0x01u');
  def('CYCAN_PF_REBOOT', '0x02u');
  def('CYCAN_PF_LOCKED_WHILE_ENABLED', '0x04u');
  def('CYCAN_PF_ADVANCED', '0x08u');
  L.push('', '/* Common parameters. */');
  def('CYCAN_PID_CAN_DATA_BITRATE', hex(CommonPid.CAN_DATA_BITRATE) + 'u');
  def('CYCAN_PID_CAN_TERMINATION', hex(CommonPid.CAN_TERMINATION) + 'u');
  def('CYCAN_PID_CTRL_TIMEOUT_MS', hex(CommonPid.CTRL_TIMEOUT_MS) + 'u');
  def('CYCAN_PID_STATUS_PERIOD(n)', `(${hex(CommonPid.STATUS_PERIOD_BASE)}u + (unsigned)(n))`);
  L.push('', '/* Common commands. */');
  for (const c of COMMON_COMMANDS) def(`CYCAN_CMD_${cname(c.key)}`, `${c.cmd}u`, c.label.en);
  L.push('', '/* Common fault bits. */');
  for (const f of COMMON_FAULTS) def(`CYCAN_FAULT_${cname(f.key)}`, `${f.bit}u`, f.label.en);
  L.push('', '/* Models. */');
  for (const m of CATALOG) def(`CYCAN_MODEL_${cname(m.key)}`, `${m.model}u`, m.name.en);

  for (const m of CATALOG) {
    const P = `CYCAN_${cname(m.key)}`;
    L.push('', `/* ---- ${m.model} - ${ascii(m.name.en)} ---------------------------------------------------- */`);
    def(`${P}_DEVTYPE`, `${m.devType}u`);
    def(`${P}_CATALOG_REV`, `${m.catalogRev}u`);
    def(`${P}_STREAM_MIN_PERIOD_US`, `${m.stream.minPeriodUs}u`);
    def(`${P}_PARAM_COUNT`, `${m.params.length}u`);
    def(`${P}_SIGNAL_COUNT`, `${m.signals.length}u`);
    def(`${P}_STATUS_FRAME_COUNT`, `${m.statusFrames.length}u`);
    for (const p of m.params) if (p.pid >= 0x0100) def(`${P}_PID_${cname(p.key)}`, `${hex(p.pid)}u`, `${PTYPE_NAME[p.ptype]} ${p.unit}`.trim());
    for (const p of m.params) {
      if (p.options) def(`${P}_ENUM_${cname(p.key)}_VALUES`, `{ ${p.options.map((o) => `${o.value}u`).join(', ')} }`, 'allowed enum values');
    }
    for (const s of m.signals) def(`${P}_SID_${cname(s.key)}`, `${s.sid}u`, s.unit || undefined);
    for (const a of m.actions) def(`${P}_CMD_${cname(a.key)}`, `${hex(a.cmd, 2)}u`, a.label.en);
    for (const f of m.faults) def(`${P}_FAULT_${cname(f.key)}`, `${f.bit}u`, f.label.en);
    for (const b of m.selfTestBits) def(`${P}_SELFTEST_${cname(b.key)}`, `${b.bit}u`, b.label.en);
    for (const c of m.controls) for (const md of c.modes ?? []) def(`${P}_MODE_${cname(md.key)}`, `${md.value}u`, `CTRL/${c.index} ${md.label.en}`);
    for (const f of m.statusFrames) {
      def(`${P}_STATUS${f.index}_DEFAULT_PERIOD_MS`, `${f.defaultPeriodMs}u`, f.label.en);
      L.push(`/* STATUS/${f.index} layout: ${ascii(f.fields
        .map((fd) => `${fd.signal}@${fd.byte}${fd.bits !== undefined ? `.${fd.bit ?? 0}:${fd.bits}` : ''} ${fd.type}${fd.type !== 'f32' && (fd.scale ?? 1) !== 1 ? ` x${fmt(fd.scale ?? 1)}` : ''}`)
        .join(', '))} */`);
    }
    if (m.params.length > 0) {
      L.push(`/* X(pid, NAME, ptype, min, max, default, min_nonzero, flags) */`);
      L.push(`#define ${P}_PARAMS(X) \\`);
      m.params.forEach((p, i) => {
        const end = i === m.params.length - 1 ? '' : ' \\';
        L.push(
          `  X(${hex(p.pid)}u, ${cname(p.key)}, ${PTYPE_C[p.ptype]}, ${cNum(p, p.min)}, ${cNum(p, p.max)}, ${cNum(p, p.default)}, ${cNum(p, p.minNonZero ?? 0)}, ${cFlags(p)})${end}`,
        );
      });
    }
  }
  L.push('', '#endif /* CYCAN_CATALOG_H */', '');
  return L.join('\n');
}

const mdPath = resolve(root, 'docs/CATALOG.md');
const hPath = resolve(root, 'firmware/cycan/include/cycan_catalog.h');
mkdirSync(dirname(hPath), { recursive: true });
writeFileSync(mdPath, catalogMarkdown());
writeFileSync(hPath, catalogHeader());
console.log(`wrote ${mdPath}\nwrote ${hPath}`);
