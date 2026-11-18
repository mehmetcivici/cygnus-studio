import { useState } from 'react';
import { LockOpen, Zap } from 'lucide-react';
import { useI18n } from '../i18n';
import { Button, ConfirmDialog, toast } from '../ui';
import { clearEstop, useDevice, useDrive, displayName } from '../core';
import { tShell } from './messages';

/** Top bar: E-STOP latch (with the clear flow) and the "actuation on" chip. */
export function EstopStatus() {
  const { t, lang } = useI18n();
  const latched = useDrive((s) => s.estopLatched);
  const session = useDrive((s) => s.session);
  const dev = useDevice(session?.armed ? session.uid48 : null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const unlock = async (): Promise<void> => {
    setBusy(true);
    try {
      const failed = await clearEstop();
      if (failed.length) toast.warn(t('core.drive.unlockFailed', { count: failed.length }));
      else toast.success(t('core.drive.unlocked'), { id: 'estop' });
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <>
      {session?.armed && (
        <span className="cy-armed-chip" title={dev ? displayName(dev, lang) : undefined}>
          <Zap size={13} aria-hidden />
          {t('core.drive.armedChip')}
        </span>
      )}
      {latched && (
        <span className="cy-latch">
          <span className="cy-latch__text">{tShell('estop.latched')}</span>
          <Button size="sm" variant="secondary" icon={LockOpen} onClick={() => setConfirm(true)}>
            {t('core.drive.unlock')}
          </Button>
        </span>
      )}
      <ConfirmDialog
        open={confirm}
        title={t('core.drive.unlock')}
        message={t('core.drive.latchedHint')}
        confirmLabel={t('core.drive.unlock')}
        busy={busy}
        onConfirm={() => void unlock()}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}
