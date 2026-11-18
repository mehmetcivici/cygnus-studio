import { useState } from 'react';
import { CircleCheck, Eraser } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Badge, Button, toast, cx } from '../../ui';
import { describeError } from '../errors';
import type { DeviceView } from '../store/deviceView';

export interface FaultListProps {
  device: DeviceView;
  /** Shows "Clear faults" (CLEAR_FAULTS) when there is something sticky to clear. */
  clearable?: boolean;
  /** Single line of badges instead of a list (cards). */
  compact?: boolean;
  className?: string;
}

const TONE = { active: 'danger', sticky: 'caution', warn: 'warn' } as const;

/** Active, sticky and warning faults with catalog labels. */
export function FaultList({ device, clearable, compact, className }: FaultListProps) {
  const { t, tl } = useI18n();
  const [busy, setBusy] = useState(false);
  const list = device.faults.list;
  if (compact) {
    if (!list.length) return null;
    // A latched fault is often both active and sticky: show each fault once, most severe kind.
    const rank = { active: 0, sticky: 1, warn: 2 } as const;
    const unique = [...list].sort((a, b) => rank[a.kind] - rank[b.kind]).filter((f, i, all) => all.findIndex((g) => g.key === f.key) === i);
    return (
      <span className={cx('cy-faults-inline', className)}>
        {unique.slice(0, 3).map((f) => (
          <Badge key={`${f.kind}-${f.bit}`} tone={TONE[f.kind]} size="sm" title={t(`core.fault.${f.kind}`)}>
            {tl(f.label)}
          </Badge>
        ))}
        {unique.length > 3 && <Badge size="sm">+{unique.length - 3}</Badge>}
      </span>
    );
  }
  const clear = async (): Promise<void> => {
    setBusy(true);
    try {
      await device.handle.clearFaults();
      toast.success(t('core.fault.cleared'));
    } catch (e) {
      toast.error(t('core.fault.clearFailed'), { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cx('cy-faults', className)}>
      {list.length === 0 ? (
        <div className="cy-faults__none">
          <CircleCheck size={15} aria-hidden /> {t('core.fault.none')}
        </div>
      ) : (
        <ul className="cy-faults__list">
          {list.map((f) => (
            <li key={`${f.kind}-${f.bit}`} className="cy-faults__item">
              <Badge tone={TONE[f.kind]} size="sm">
                {t(`core.fault.${f.kind}`)}
              </Badge>
              <span className="cy-faults__label">{tl(f.label)}</span>
              <span className="cy-faults__key cy-mono">{f.key}</span>
            </li>
          ))}
        </ul>
      )}
      {clearable && device.handle.capabilities.faults && (device.faults.sticky !== 0 || device.faults.active !== 0) && (
        <Button size="sm" variant="secondary" icon={Eraser} loading={busy} onClick={() => void clear()} disabled={!device.online}>
          {t('core.fault.clear')}
        </Button>
      )}
    </div>
  );
}
