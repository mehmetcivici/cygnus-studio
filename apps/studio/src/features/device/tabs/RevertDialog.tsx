import { useMemo, useState } from 'react';
import { History } from 'lucide-react';
import { paramByKey } from '@cygnus/protocol';
import { useI18n } from '../../../i18n';
import { Button, Checkbox, Modal, ProgressBar, SegmentedControl, toast } from '../../../ui';
import { paramCache, type DeviceView } from '../../../core';
import { diffFromSaved } from '../logic/baseline';
import type { DiffRow } from '../logic/paramFile';
import { rebootDevice, saveDevice, writeValues } from '../ops';
import { tDevice } from '../messages';
import { DiffTable } from './DiffTable';

type Way = 'write' | 'reboot';

/**
 * "Revert to saved": either write back the values the board last saved (remembered by the
 * Studio, no reboot) or reboot so the board loads its flash. Optionally re-reads afterwards.
 */
export function RevertDialog({ device, onClose }: { device: DeviceView; onClose: () => void }) {
  const { t } = useI18n();
  const def = device.def;
  const diff = useMemo(() => diffFromSaved(device.handle), [device.handle]);
  const known = diff.writes.length > 0 || diff.unknown.length === 0;
  const [way, setWay] = useState<Way>(known ? 'write' : 'reboot');
  const [reread, setReread] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const rows: DiffRow[] = useMemo(
    () => diff.writes.map((w) => ({ key: w.key, def: def ? paramByKey(def, w.key) : undefined, from: w.from, to: w.to, status: 'change' as const })),
    [diff, def],
  );
  const nothing = !device.flags.unsaved && diff.writes.length === 0;
  const h = device.handle;

  const run = async (): Promise<void> => {
    setProgress(0);
    if (way === 'write') {
      const failed = await writeValues(
        h,
        diff.writes.map((w) => ({ key: w.key, value: w.to })),
        (d, n) => setProgress(d / n),
      );
      // Values now equal flash; saving clears the UNSAVED flag without changing anything.
      if (!failed.length) await saveDevice(h, true);
      if (reread) await paramCache.loadAll(device.uid48).catch(() => undefined);
      if (failed.length) toast.error(tDevice('settings.applyPartial', { count: failed.length }));
      else toast.success(tDevice('revert.done', { count: diff.writes.length }));
    } else {
      // After the reboot the board reloads flash; the parameter views re-read once it is back.
      void rebootDevice(h);
    }
    setProgress(null);
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={progress === null}
      title={tDevice('revert.title')}
      footer={
        nothing ? (
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={progress !== null}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              icon={History}
              loading={progress !== null}
              disabled={!device.online || (way === 'reboot' && device.flags.enabled)}
              onClick={() => void run()}
            >
              {way === 'write' ? tDevice('revert.write', { count: diff.writes.length }) : tDevice('revert.reboot')}
            </Button>
          </>
        )
      }
    >
      <div className="dv-dialog">
        {nothing ? (
          <p className="dv-note dv-note--center">{tDevice('revert.nothing')}</p>
        ) : (
          <>
            <SegmentedControl<Way>
              value={way}
              onChange={setWay}
              block
              options={[
                { value: 'write', label: tDevice('revert.wayWrite'), disabled: !known },
                { value: 'reboot', label: tDevice('revert.wayReboot') },
              ]}
            />
            {way === 'write' ? (
              <>
                <p className="dv-note">{tDevice('revert.writeHelp')}</p>
                {diff.unknown.length > 0 && <p className="dv-note dv-warntext">{tDevice('revert.unknown', { count: diff.unknown.length })}</p>}
                <DiffTable rows={rows} fromLabel={tDevice('diff.now')} toLabel={tDevice('diff.saved')} maxHeight={260} />
                <Checkbox checked={reread} onChange={setReread} label={tDevice('revert.reread')} />
              </>
            ) : (
              <p className="dv-note">{device.flags.enabled ? tDevice('settings.lockedEnabled') : tDevice('revert.rebootHelp')}</p>
            )}
          </>
        )}
        {progress !== null && way === 'write' && <ProgressBar value={progress} />}
      </div>
    </Modal>
  );
}
