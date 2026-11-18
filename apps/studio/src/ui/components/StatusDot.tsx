import './StatusDot.css';
import { useI18n } from '../../i18n';
import { cx, type DeviceStatus } from './types';

export interface StatusDotProps {
  status: DeviceStatus;
  /** Pulse animation; defaults to on for `fault` and `boot`. */
  pulse?: boolean;
  /** Dot diameter in px (default 8). */
  size?: number;
  /** Render the localized status name next to the dot. */
  withLabel?: boolean;
  /** Override the label text (also used as accessible name). */
  label?: string;
  className?: string;
}

/** Colored health indicator: ok · warn · fault · offline · boot. */
export function StatusDot({ status, pulse, size = 8, withLabel, label, className }: StatusDotProps) {
  const { t } = useI18n();
  const text = label ?? t(`status.${status}`);
  const animate = pulse ?? (status === 'fault' || status === 'boot');
  return (
    <span className={cx('cy-status', `cy-status--${status}`, className)} role="img" aria-label={withLabel ? undefined : text} title={withLabel ? undefined : text}>
      <span className={cx('cy-status__dot', animate && 'is-pulsing')} style={{ width: size, height: size }} />
      {withLabel && <span className="cy-status__label">{text}</span>}
    </span>
  );
}
