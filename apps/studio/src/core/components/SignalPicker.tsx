import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Checkbox, TextField, cx } from '../../ui';
import { useDevices } from '../store/hooks';
import type { DeviceView } from '../store/deviceView';
import { DeviceBadge } from './DeviceBadge';

export interface SignalRef {
  uid48: string;
  key: string;
}

export interface SignalPickerProps {
  value: readonly SignalRef[];
  onChange: (next: SignalRef[]) => void;
  /** Most signals that can be selected (e.g. 8 chart series). */
  max?: number;
  /** Limit the boards shown. */
  filterDevice?: (d: DeviceView) => boolean;
  /** Hide discrete (enum/bit) signals. Default false. */
  numericOnly?: boolean;
  /** List height in px (default 320). */
  height?: number;
  className?: string;
}

export const sameSignal = (a: SignalRef, b: SignalRef): boolean => a.uid48 === b.uid48 && a.key === b.key;

/** Searchable multi-board signal checklist (Plot, recorder). */
export function SignalPicker({ value, onChange, max, filterDevice, numericOnly, height = 320, className }: SignalPickerProps) {
  const { t, tl } = useI18n();
  const devices = useDevices();
  const [q, setQ] = useState('');
  const query = q.trim().toLocaleLowerCase();
  const groups = useMemo(
    () =>
      devices
        .filter((d) => d.def && !d.unassigned && !d.conflict && (!filterDevice || filterDevice(d)))
        .map((d) => {
          const devMatch = !query || d.name.toLocaleLowerCase().includes(query) || tl(d.def?.name).toLocaleLowerCase().includes(query);
          const signals = (d.def?.signals ?? []).filter(
            (s) =>
              (!numericOnly || (!s.options && !s.bits)) &&
              (devMatch || s.key.includes(query) || tl(s.label).toLocaleLowerCase().includes(query)),
          );
          return { d, signals };
        })
        .filter((g) => g.signals.length > 0),
    [devices, filterDevice, numericOnly, query, tl],
  );
  const full = max !== undefined && value.length >= max;
  const toggle = (ref: SignalRef, on: boolean): void => {
    if (on) {
      if (!full) onChange([...value, ref]);
    } else onChange(value.filter((r) => !sameSignal(r, ref)));
  };
  return (
    <div className={cx('cy-sigpick', className)}>
      <div className="cy-sigpick__head">
        <TextField value={q} onChange={setQ} icon={Search} placeholder={t('core.picker.searchSignals')} size="sm" block />
        <span className="cy-sigpick__count">
          {max !== undefined ? t('core.picker.selectedOf', { count: value.length, max }) : t('common.selected', { count: value.length })}
        </span>
      </div>
      <div className="cy-sigpick__list" style={{ maxHeight: height }}>
        {groups.length === 0 && <div className="cy-sigpick__empty">{t('core.picker.noSignals')}</div>}
        {groups.map(({ d, signals }) => (
          <div key={d.uid48} className="cy-sigpick__group">
            <div className="cy-sigpick__dev">
              <DeviceBadge device={d} size="sm" showIcon />
            </div>
            {signals.map((s) => {
              const ref = { uid48: d.uid48, key: s.key };
              const on = value.some((r) => sameSignal(r, ref));
              return (
                <div
                  key={s.key}
                  className={cx('cy-sigpick__row', on && 'is-on', !on && full && 'is-disabled')}
                  onClick={(e) => {
                    // The checkbox handles its own clicks; the rest of the row toggles too.
                    if (!(e.target as HTMLElement).closest('.cy-check')) toggle(ref, !on);
                  }}
                >
                  <Checkbox checked={on} disabled={!on && full} onChange={(c) => toggle(ref, c)} ariaLabel={tl(s.label)} />
                  <span className="cy-sigpick__label">{tl(s.label)}</span>
                  {s.unit && <span className="cy-sigpick__unit">{s.unit}</span>}
                  <span className="cy-sigpick__key cy-mono">{s.key}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
