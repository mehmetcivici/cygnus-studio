import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Power, PowerOff } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Tooltip, toast, cx } from '../../ui';
import { useDrive, type DriveSession } from './drive';
import './safety.css';

export interface ArmButtonProps {
  /** From `useDriveSession`; null shows a disabled button (another screen drives). */
  session: DriveSession | null;
  /** Hold time before arming, ms (default 1000). */
  holdMs?: number;
  label?: string;
  armedLabel?: string;
  disabled?: boolean;
  size?: 'md' | 'lg';
  block?: boolean;
  /** Called after a successful arm. */
  onArmed?: () => void;
}

const R = 9;
const C = 2 * Math.PI * R;

/**
 * Hold-to-arm switch for actuation. Pointer or Enter must be held for `holdMs`; while armed a
 * single click disarms. Space is E-STOP everywhere, so it is never the hold key.
 */
export function ArmButton({ session, holdMs = 1000, label, armedLabel, disabled, size = 'md', block, onArmed }: ArmButtonProps) {
  const { t } = useI18n();
  const info = useDrive((s) => s.session);
  const latched = useDrive((s) => s.estopLatched);
  const armed = !!session && info?.id === session.id && info.armed;
  const [progress, setProgress] = useState(0);
  const holdStart = useRef<number | null>(null);
  const raf = useRef(0);

  const cancel = (): void => {
    holdStart.current = null;
    cancelAnimationFrame(raf.current);
    setProgress(0);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  useEffect(() => {
    if (armed) cancel();
  }, [armed]);

  const finish = (): void => {
    cancel();
    if (!session) return;
    const r = session.arm();
    if (r.ok) onArmed?.();
    else toast.warn(t(`core.drive.block.${r.reason}`), { id: 'arm-block' });
  };

  const begin = (): void => {
    if (!session || disabled || armed || holdStart.current !== null) return;
    holdStart.current = performance.now();
    const step = (): void => {
      if (holdStart.current === null) return;
      const p = Math.min(1, (performance.now() - holdStart.current) / holdMs);
      setProgress(p);
      if (p >= 1) finish();
      else raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.repeat) {
      e.preventDefault();
      if (armed) session?.disarm();
      else begin();
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !armed) cancel();
  };

  const blocked = !session || disabled;
  const text = armed ? (armedLabel ?? t('core.drive.disarm')) : progress > 0 ? t('core.drive.holding') : (label ?? t('core.drive.arm'));
  const button = (
    <button
      type="button"
      className={cx('cy-arm', `cy-arm--${size}`, armed && 'is-armed', progress > 0 && 'is-holding', block && 'is-block')}
      disabled={blocked}
      aria-pressed={armed}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (armed) session?.disarm();
        else begin();
      }}
      onPointerUp={() => !armed && cancel()}
      onPointerLeave={() => !armed && cancel()}
      onPointerCancel={cancel}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <span className="cy-arm__icon" aria-hidden>
        <svg viewBox="0 0 24 24" width="24" height="24">
          <circle cx="12" cy="12" r={R} className="cy-arm__track" />
          <circle cx="12" cy="12" r={R} className="cy-arm__ring" strokeDasharray={C} strokeDashoffset={C * (1 - (armed ? 1 : progress))} />
        </svg>
        {armed ? <PowerOff size={12} strokeWidth={2.6} /> : <Power size={12} strokeWidth={2.6} />}
      </span>
      <span className="cy-arm__label">{text}</span>
    </button>
  );
  const hint = !session ? t('core.drive.busy') : latched ? t('core.drive.block.estopLatched') : armed ? t('core.drive.disarmHint') : t('core.drive.holdHint');
  return (
    <Tooltip content={hint} block={block}>
      {button}
    </Tooltip>
  );
}
