import { PType, type ParamDef } from '@cygnus/protocol';
import { fmtNumber, t as translate, tl, useI18n, type Lang } from '../../../i18n';
import { Badge, Checkbox, cx, type Tone } from '../../../ui';
import type { DiffRow, DiffStatus } from '../logic/paramFile';
import { tDevice } from '../messages';

/** Parameter value for reading: option label, on/off, or number with unit. */
export function fmtParam(def: ParamDef | undefined, v: number | undefined, lang: Lang): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  if (!def) return String(v);
  if (def.options) {
    const o = def.options.find((x) => x.value === v);
    if (o) return tl(o.label, lang);
  }
  if (def.ptype === PType.BOOL) return v ? translate('common.on', undefined, lang) : translate('common.off', undefined, lang);
  const digits = def.ptype === PType.F32 ? Math.min(6, Math.max(def.digits, String(Math.abs(v)).split('.')[1]?.length ?? 0)) : 0;
  return `${fmtNumber(v, digits, { lang })}${def.unit ? ` ${def.unit}` : ''}`;
}

const STATUS_TONE: Record<DiffStatus, Tone> = { change: 'accent', same: 'neutral', unknown: 'caution', invalid: 'danger', readOnly: 'neutral' };

export interface DiffTableProps {
  rows: readonly DiffRow[];
  selected?: ReadonlySet<string>;
  onToggle?: (key: string, on: boolean) => void;
  /** Hide rows that are equal already. */
  onlyDiff?: boolean;
  /** Column titles for from / to. */
  fromLabel: string;
  toLabel: string;
  maxHeight?: number;
}

/** Parameter comparison: label, key, board value → new value, status; selectable change rows. */
export function DiffTable({ rows, selected, onToggle, onlyDiff, fromLabel, toLabel, maxHeight = 360 }: DiffTableProps) {
  const { lang } = useI18n();
  const shown = onlyDiff ? rows.filter((r) => r.status !== 'same') : rows;
  if (shown.length === 0) return <p className="dv-note dv-note--center">{tDevice('diff.none')}</p>;
  return (
    <div className="dv-table-wrap" style={{ maxHeight }}>
      <table className="dv-table">
        <thead>
          <tr>
            {onToggle && <th className="dv-table__check" aria-label={tDevice('diff.select')} />}
            <th>{tDevice('diff.param')}</th>
            <th className="is-num">{fromLabel}</th>
            <th className="is-num">{toLabel}</th>
            <th>{tDevice('diff.status')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.key} className={cx(r.status !== 'change' && 'is-muted')}>
              {onToggle && (
                <td className="dv-table__check">
                  {r.status === 'change' && <Checkbox checked={selected?.has(r.key) ?? false} onChange={(on) => onToggle(r.key, on)} ariaLabel={r.key} />}
                </td>
              )}
              <td>
                <div className="dv-table__label">{r.def ? tl(r.def.label, lang) : r.key}</div>
                <div className="dv-table__key cy-mono">
                  {r.key}
                  {r.def?.rebootRequired && <Badge size="sm" tone="caution">{translate('common.rebootRequired', undefined, lang)}</Badge>}
                </div>
              </td>
              <td className="is-num cy-mono">{fmtParam(r.def, r.from, lang)}</td>
              <td className="is-num cy-mono">{fmtParam(r.def, r.to, lang)}</td>
              <td>
                <Badge size="sm" tone={STATUS_TONE[r.status]}>
                  {tDevice(`diff.st.${r.status}`)}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
