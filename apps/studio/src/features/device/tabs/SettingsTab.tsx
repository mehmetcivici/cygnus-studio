import { useCallback, useMemo, useState } from 'react';
import { Copy, Download, Factory, History, Power, Save, TriangleAlert, Upload } from 'lucide-react';
import { paramByKey } from '@cygnus/protocol';
import { useI18n } from '../../../i18n';
import { Badge, Button, Checkbox, ConfirmDialog, Tooltip, toast } from '../../../ui';
import { ParamForm, matchDevice, useDevices, describeError, downloadFile, fmtFw, paramCache, pickFile, safeFileName, displayName, type DeviceView } from '../../../core';
import { buildParamFile, parseParamFile, serializeParamFile, PARAM_FILE_EXT, type ParamFile } from '../logic/paramFile';
import { readValues, rebootDevice, saveDevice } from '../ops';
import { tDevice } from '../messages';
import { ImportDialog } from './ImportDialog';
import { CopyDialog } from './CopyDialog';
import { RevertDialog } from './RevertDialog';

/** Settings: catalog form plus save / revert / defaults / file / copy actions. */
export function SettingsTab({ device }: { device: DeviceView }) {
  const { lang } = useI18n();
  const h = device.handle;
  const def = device.def;
  const online = device.online;
  const [saving, setSaving] = useState(false);
  const [factoryOpen, setFactoryOpen] = useState(false);
  const [factorySave, setFactorySave] = useState(false);
  const [factoryBusy, setFactoryBusy] = useState(false);
  const [revertOpen, setRevertOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const devices = useDevices();
  // Copying needs another board of the same model; without one the button explains why.
  const copyTargets = useMemo(
    () => devices.filter((d) => d.uid48 !== device.uid48 && matchDevice(d, { capability: 'params', models: device.def ? [device.def.key] : [], includeOffline: true })).length,
    [devices, device.uid48, device.def],
  );
  const [imported, setImported] = useState<ParamFile | null>(null);
  const [exporting, setExporting] = useState(false);
  /** Keys written in this visit that only take effect after a reboot. */
  const [rebootKeys, setRebootKeys] = useState<string[]>([]);
  const [rebooting, setRebooting] = useState(false);

  const noteApplied = useCallback(
    (keys: readonly string[]) => {
      if (!def) return;
      const rb = keys.filter((k) => paramByKey(def, k)?.rebootRequired);
      if (rb.length) setRebootKeys((cur) => [...new Set([...cur, ...rb])]);
    },
    [def],
  );

  if (!def) return null;

  const save = async (): Promise<void> => {
    setSaving(true);
    await saveDevice(h);
    setSaving(false);
  };

  const exportFile = async (): Promise<void> => {
    setExporting(true);
    try {
      const values = await readValues(h);
      const file = buildParamFile(def, { uid48: device.uid48, num: device.num, name: device.name, fw: device.fw ? fmtFw(device.fw) : null }, values);
      downloadFile(`${safeFileName(`${displayName(device, lang)}-${def.key}-${device.num}`)}${PARAM_FILE_EXT}`, serializeParamFile(file), 'application/json');
      toast.success(tDevice('settings.exported', { count: Object.keys(file.params).length }));
    } catch (e) {
      toast.error(tDevice('settings.exportFailed'), { description: describeError(e) });
    } finally {
      setExporting(false);
    }
  };

  const importFile = async (): Promise<void> => {
    const f = await pickFile(`${PARAM_FILE_EXT},.json,application/json`);
    if (!f) return;
    const res = parseParamFile(await f.text(), def);
    if (!res.ok) {
      toast.error(tDevice('settings.importFailed'), { description: tDevice(`file.err.${res.error}`, { model: res.fileModelKey ?? '' }) });
      return;
    }
    setImported(res.file);
  };

  const factory = async (): Promise<void> => {
    setFactoryBusy(true);
    try {
      await h.loadDefaults();
      if (factorySave) await saveDevice(h, true);
      await paramCache.loadAll(device.uid48);
      toast.success(factorySave ? tDevice('settings.factoryDoneSaved') : tDevice('settings.factoryDone'));
      setFactoryOpen(false);
    } catch (e) {
      toast.error(tDevice('settings.factoryFailed'), { description: describeError(e) });
    } finally {
      setFactoryBusy(false);
    }
  };

  const saveAndReboot = async (): Promise<void> => {
    setRebooting(true);
    if (await saveDevice(h, true)) {
      if (await rebootDevice(h)) setRebootKeys([]);
    }
    setRebooting(false);
  };

  const enabled = device.flags.enabled;

  return (
    <div className="dv-settings">
      <div className="dv-actionbar" role="toolbar" aria-label={tDevice('settings.toolbar')}>
        <div className="dv-actionbar__group">
          {device.flags.unsaved ? (
            <Badge tone="caution" variant="outline" icon={TriangleAlert}>
              {tDevice('settings.unsaved')}
            </Badge>
          ) : (
            <Badge tone="ok">{tDevice('settings.saved')}</Badge>
          )}
          <Button size="sm" variant={device.flags.unsaved ? 'primary' : 'secondary'} icon={Save} loading={saving} disabled={!online} onClick={() => void save()}>
            {tDevice('settings.save')}
          </Button>
          <Button size="sm" variant="ghost" icon={History} disabled={!online} onClick={() => setRevertOpen(true)}>
            {tDevice('settings.revert')}
          </Button>
          <Button size="sm" variant="ghost" icon={Factory} disabled={!online || enabled} onClick={() => setFactoryOpen(true)} title={enabled ? tDevice('settings.lockedEnabled') : undefined}>
            {tDevice('settings.factory')}
          </Button>
        </div>
        <div className="dv-actionbar__group">
          <Button size="sm" variant="ghost" icon={Download} loading={exporting} disabled={!online} onClick={() => void exportFile()}>
            {tDevice('settings.export')}
          </Button>
          <Button size="sm" variant="ghost" icon={Upload} disabled={!online} onClick={() => void importFile()}>
            {tDevice('settings.import')}
          </Button>
          <Tooltip content={copyTargets === 0 ? tDevice('copy.noTargets') : tDevice('settings.copy')}>
            <span>
              <Button size="sm" variant="secondary" icon={Copy} disabled={!online || copyTargets === 0} onClick={() => setCopyOpen(true)}>
                {tDevice('settings.copy')}
              </Button>
            </span>
          </Tooltip>
        </div>
      </div>

      {rebootKeys.length > 0 && (
        <div className="dv-strip dv-strip--caution" role="status">
          <Power size={15} aria-hidden />
          <span>{tDevice('settings.rebootHint', { keys: rebootKeys.join(', ') })}</span>
          <span className="dv-strip__spacer" />
          <Button size="sm" variant="ghost" onClick={() => setRebootKeys([])}>
            {tDevice('settings.later')}
          </Button>
          <Button size="sm" variant="primary" icon={Power} loading={rebooting} disabled={!online || enabled} onClick={() => void saveAndReboot()}>
            {tDevice('settings.saveReboot')}
          </Button>
        </div>
      )}

      <ParamForm uid48={device.uid48} onApplied={noteApplied} className="dv-paramform" />

      <ConfirmDialog
        open={factoryOpen}
        tone="danger"
        busy={factoryBusy}
        title={tDevice('settings.factoryTitle')}
        confirmLabel={tDevice('settings.factoryConfirm')}
        message={
          <>
            <p>{tDevice('settings.factoryBody')}</p>
            <Checkbox checked={factorySave} onChange={setFactorySave} label={tDevice('settings.factorySave')} />
          </>
        }
        onConfirm={() => void factory()}
        onCancel={() => setFactoryOpen(false)}
      />
      {revertOpen && <RevertDialog device={device} onClose={() => setRevertOpen(false)} />}
      {copyOpen && <CopyDialog device={device} onClose={() => setCopyOpen(false)} />}
      {imported && <ImportDialog device={device} file={imported} onClose={() => setImported(null)} onApplied={noteApplied} />}
    </div>
  );
}
