import { useEffect, useState } from 'react';
import { OctagonAlert, Info, Square } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button, Kbd } from '../../ui';
import { useDevice } from '../store/hooks';
import { displayName } from '../store/deviceView';
import { useDrive, type DriveSession } from './drive';
import { drive } from './index';
import './safety.css';

export interface DriveBannerProps {
  /** Show only for this session (default: whichever session is armed). */
  session?: DriveSession | null;
  /** Owner whose last automatic stop is explained (default: the session's owner). */
  owner?: string;
}

const RECENT_MS = 8000;

/** Full-width strip: loud while armed; afterwards briefly explains why actuation stopped. */
export function DriveBanner({ session, owner }: DriveBannerProps) {
  const { t, lang } = useI18n();
  const info = useDrive((s) => s.session);
  const lastStop = useDrive((s) => s.lastStop);
  const armed = !!info?.armed && (session === undefined || session?.id === info.id);
  const dev = useDevice(armed ? info?.uid48 : lastStop?.uid48);
  const [now, setNow] = useState(() => Date.now());
  const stopOwner = owner ?? session?.owner;
  const recent = !!lastStop && now - lastStop.at < RECENT_MS && (stopOwner === undefined || lastStop.owner === stopOwner);
  useEffect(() => {
    if (!lastStop) return;
    setNow(Date.now());
    const h = window.setTimeout(() => setNow(Date.now()), RECENT_MS + 50);
    return () => window.clearTimeout(h);
  }, [lastStop]);

  if (armed && info) {
    return (
      <div className="cy-drive-banner is-armed" role="alert">
        <OctagonAlert size={18} aria-hidden />
        <strong>{t('core.drive.armedTitle')}</strong>
        <span className="cy-drive-banner__dev">{dev ? `${displayName(dev, lang)} · #${dev.num}` : info.uid48}</span>
        <span className="cy-drive-banner__hint">
          <Kbd>{lang === 'tr' ? 'Boşluk' : 'Space'}</Kbd> {t('core.drive.estopHint')}
        </span>
        <Button size="sm" variant="danger" icon={Square} onClick={() => drive.stopSession('released')}>
          {t('core.drive.disarm')}
        </Button>
      </div>
    );
  }
  if (recent && lastStop) {
    return (
      <div className="cy-drive-banner is-stopped" role="status">
        <Info size={16} aria-hidden />
        <span>{t('core.drive.stopped', { reason: t(`core.drive.reason.${lastStop.reason}`) })}</span>
      </div>
    );
  }
  return null;
}
