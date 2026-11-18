import { useEffect, useState } from 'react';
import { Button, Checkbox, Modal, Select } from '../../ui';
import { useI18n } from '../../i18n';
import { displayName, useBus, type DeviceView } from '../../core';
import type { DeviceHandle } from '@cygnus/protocol';
import { fmtVersion, imageVersion, isDowngrade, type FwImage } from './logic';
import type { FwSafety } from './safety';
import { updateMany, updateOne } from './store';
import type { FwRow } from './rows';
import { SafetyNotes } from './parts';
import { tFirmware } from './messages';

export type FlashMode = 'update' | 'recover' | 'pick';

/** Single board: update, recovery from the bootloader, retry, or choosing another (maybe older) version. */
export function FlashDialog({ row, mode, imageId, safety, onClose }: { row: FwRow; mode: FlashMode; imageId?: string; safety: FwSafety; onClose: () => void }) {
  const { t, lang } = useI18n();
  const [pick, setPick] = useState<string | null>(imageId ?? row.assessment.best?.id ?? row.compatible[0]?.id ?? null);
  const [downgradeOk, setDowngradeOk] = useState(false);
  const [lowOk, setLowOk] = useState(false);
  const image = row.compatible.find((i) => i.id === pick);
  const down = image ? isDowngrade(row.view.fw, image) : false;
  useEffect(() => setDowngradeOk(false), [pick]);

  const name = displayName(row.view, lang);
  const title = mode === 'recover' ? tFirmware('flash.titleRecover') : mode === 'pick' ? tFirmware('flash.titlePick') : tFirmware('flash.titleUpdate');
  const ready = image !== undefined && !safety.driveActive && (!down || downgradeOk) && (!safety.lowVoltage || lowOk);
  const go = (): void => {
    if (!image) return;
    void updateOne({ device: row.view.handle, name, image });
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`${title} — ${name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant={mode === 'recover' ? 'danger' : 'primary'} disabled={!ready} onClick={go} data-testid="fw-flash-go">
            {tFirmware('flash.start')}
          </Button>
        </>
      }
    >
      <div className="fw-dialog">
        {mode === 'recover' && <p className="fw-dialog__lead">{tFirmware('flash.recoverBody')}</p>}
        <div className="fw-dialog__row">
          <span className="fw-dialog__label">{tFirmware('flash.installed')}</span>
          <span className="cy-mono">{fmtVersion(row.view.fw)}</span>
        </div>
        {row.compatible.length === 0 ? (
          <p className="fw-dialog__warn">{tFirmware('flash.noCompatible')}</p>
        ) : (
          <div className="fw-dialog__row">
            <span className="fw-dialog__label">{tFirmware('flash.pickImage')}</span>
            <Select
              value={pick}
              onChange={setPick}
              ariaLabel={tFirmware('flash.pickImage')}
              width={260}
              options={row.compatible.map((i) => ({
                value: i.id,
                label: `${fmtVersion(imageVersion(i.header))} — ${i.fileName}${isDowngrade(row.view.fw, i) ? ` (${tFirmware('flash.downgrade')})` : ''}`,
              }))}
            />
          </div>
        )}
        {down && image && (
          <div className="fw-note fw-note--warn">
            <strong>{tFirmware('confirm.downgradeTitle')}</strong>
            <p>{tFirmware('confirm.downgradeBody', { from: fmtVersion(row.view.fw), to: fmtVersion(imageVersion(image.header)) })}</p>
            <Checkbox checked={downgradeOk} onChange={setDowngradeOk} label={tFirmware('confirm.downgradeCheck')} />
          </div>
        )}
        <SafetyNotes safety={safety} lowOk={lowOk} onLowOk={setLowOk} />
        <p className="fw-dialog__hint">{tFirmware('confirm.body')}</p>
      </div>
    </Modal>
  );
}

/** Many boards at once through `bus.updateAllFirmware`; always the newest compatible image, never a downgrade. */
export function BatchDialog({ rows, images, safety, onClose }: { rows: FwRow[]; images: FwImage[]; safety: FwSafety; onClose: () => void }) {
  const { t, lang } = useI18n();
  const bus = useBus();
  const [lowOk, setLowOk] = useState(false);
  const count = rows.filter((r) => r.assessment.status === 'updateAvailable' || r.assessment.status === 'bootloader').length;
  const ready = bus !== null && !safety.driveActive && (!safety.lowVoltage || lowOk);
  const go = (): void => {
    if (!bus) return;
    const devices = rows.map((r: FwRow) => ({ device: r.view.handle as DeviceHandle, name: displayName(r.view as DeviceView, lang) }));
    void updateMany(bus, devices, images);
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={tFirmware('confirm.titleAll', { count })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!ready} onClick={go} data-testid="fw-batch-go">
            {tFirmware('confirm.start')}
          </Button>
        </>
      }
    >
      <div className="fw-dialog">
        <SafetyNotes safety={safety} lowOk={lowOk} onLowOk={setLowOk} />
        <p className="fw-dialog__hint">{tFirmware('confirm.body')}</p>
      </div>
    </Modal>
  );
}
