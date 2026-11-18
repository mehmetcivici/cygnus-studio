import { useEffect, useMemo } from 'react';
import type { DeviceCapabilities, ModelCategory } from '@cygnus/protocol';
import { useI18n } from '../../i18n';
import { Select, type ControlSize } from '../../ui';
import { useDevices } from '../store/hooks';
import { displayName, modelText, type DeviceView } from '../store/deviceView';

export interface DeviceFilter {
  /** Required capability, e.g. `stream` for the tuner, `firmware` for updates. */
  capability?: keyof DeviceCapabilities;
  /** Catalog model codes (`Model.ESC_80A`) or keys (`esc80a`). */
  models?: readonly (number | string)[];
  categories?: readonly ModelCategory[];
  /** Include lost boards (default false). Unresolved boards are never offered. */
  includeOffline?: boolean;
  /** Extra predicate. */
  where?: (d: DeviceView) => boolean;
}

/** Shared filter logic (also usable for lists). */
export function matchDevice(d: DeviceView, f: DeviceFilter): boolean {
  if (d.unassigned || d.conflict) return false;
  if (!f.includeOffline && !d.online) return false;
  if (f.capability && !d.handle.capabilities[f.capability]) return false;
  if (f.models && !f.models.some((m) => (typeof m === 'number' ? m === d.model : m === d.def?.key))) return false;
  if (f.categories && (!d.def || !f.categories.includes(d.def.category))) return false;
  return !f.where || f.where(d);
}

export interface DevicePickerProps extends DeviceFilter {
  value: string | null;
  onChange: (uid48: string) => void;
  /** Picks the first match when nothing (or a vanished board) is selected. */
  autoSelect?: boolean;
  placeholder?: string;
  size?: ControlSize;
  width?: number | string;
  disabled?: boolean;
  ariaLabel?: string;
}

/** Board selector filtered by capability / model / category. Value is the uid48. */
export function DevicePicker({ value, onChange, autoSelect, placeholder, size, width = 280, disabled, ariaLabel, ...filter }: DevicePickerProps) {
  const { t, lang, tl } = useI18n();
  const devices = useDevices();
  const { capability, models, categories, includeOffline, where } = filter;
  const matches = useMemo(
    () => devices.filter((d) => matchDevice(d, { capability, models, categories, includeOffline, where })),
    [devices, capability, models, categories, includeOffline, where],
  );
  const firstUid = matches[0]?.uid48;
  const valid = value !== null && matches.some((d) => d.uid48 === value);
  useEffect(() => {
    if (autoSelect && !valid && firstUid) onChange(firstUid);
  }, [autoSelect, valid, firstUid, onChange]);
  const options = matches.map((d) => {
    const name = displayName(d, lang);
    const model = tl(modelText(d));
    return { value: d.uid48, label: `${name}${name !== model ? ` · ${model}` : ''} · #${d.num}${d.online ? '' : ` (${t('status.offline')})`}` };
  });
  return (
    <Select<string>
      value={valid ? value : null}
      options={options}
      onChange={onChange}
      placeholder={matches.length ? (placeholder ?? t('core.picker.device')) : t('core.picker.noDevices')}
      size={size}
      width={width}
      disabled={disabled || matches.length === 0}
      ariaLabel={ariaLabel ?? t('core.picker.device')}
    />
  );
}
