import { signalByKey } from '@cygnus/protocol';
import { useI18n } from '../../i18n';
import { StatTile, cx, type IconComponent, type Tone } from '../../ui';
import { formatSignal, isDiscrete, rangeTone } from '../catalog';
import { useTrend } from '../recorder/history';
import { toDisplayUnit, useSettings } from '../settings';
import { useDevice, useSignal } from '../store/hooks';

export interface SignalTileProps {
  uid48: string;
  /** Catalog signal key. */
  signal: string;
  /** Overrides the catalog label. */
  label?: string;
  /** Sparkline of recent STATUS values (default true; uses the shared signal history). */
  trend?: boolean;
  tone?: Tone;
  icon?: IconComponent;
  size?: 'md' | 'lg';
  caption?: string;
  className?: string;
}

/** Live catalog signal as a StatTile: label, unit and digits from the catalog, unit preferences applied. */
export function SignalTile({ uid48, signal, label, trend = true, tone, icon, size, caption, className }: SignalTileProps) {
  const { lang, tl } = useI18n();
  const dev = useDevice(uid48);
  const def = dev?.def ? signalByKey(dev.def, signal) : undefined;
  const v = useSignal(uid48, signal);
  const angleUnit = useSettings((s) => s.angleUnit);
  const tempUnit = useSettings((s) => s.tempUnit);
  const discrete = def ? isDiscrete(def) : false;
  const values = useTrend(trend && !discrete ? uid48 : null, signal);
  const title = label ?? (def ? tl(def.label) : signal);
  if (def && discrete) {
    const f = formatSignal(def, v, lang);
    return (
      <div className={cx('cy-stat', `cy-stat--${tone ?? 'neutral'}`, `cy-stat--${size ?? 'md'}`, 'cy-stat--text', className)}>
        <div className="cy-stat__label">
          <span>{title}</span>
        </div>
        <div className="cy-stat__value">
          <span className="cy-stat__num cy-stat__num--text">{f.text}</span>
        </div>
        {caption && <div className="cy-stat__caption">{caption}</div>}
      </div>
    );
  }
  const units = { angleUnit, tempUnit };
  const disp = def && Number.isFinite(v) ? toDisplayUnit(v, def.unit, units) : { value: v, unit: def?.unit ?? '' };
  const conv = def ? toDisplayUnit(1, def.unit, units) : null;
  const scaled = conv && def && conv.unit !== def.unit ? values.map((x) => toDisplayUnit(x, def.unit, units).value) : values;
  return (
    <StatTile
      label={title}
      value={Number.isFinite(disp.value) ? disp.value : null}
      unit={disp.unit}
      digits={def ? (disp.unit === def.unit ? def.digits : Math.max(0, def.digits - 1)) : 2}
      tone={tone ?? rangeTone(def, v)}
      icon={icon}
      trend={trend ? scaled : undefined}
      caption={caption}
      size={size}
      className={className}
    />
  );
}
