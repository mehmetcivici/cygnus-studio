import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { Button, Checkbox, Modal, ProgressBar, Spinner, Toggle, toast } from '../../../ui';
import { describeError, type DeviceView } from '../../../core';
import { changedKeys, diffParams, needsReboot, type DiffRow, type ParamFile } from '../logic/paramFile';
import { readValues, saveDevice, writeValues } from '../ops';
import { tDevice } from '../messages';
import { DiffTable } from './DiffTable';

export interface ImportDialogProps {
  device: DeviceView;
  file: ParamFile;
  onClose: () => void;
  onApplied: (keys: string[]) => void;
}

/** Preview of a settings file against the board; the user picks which changes to write. */
export function ImportDialog({ device, file, onClose, onApplied }: ImportDialogProps) {
  const { t, lang } = useI18n();
  const def = device.def;
  const [rows, setRows] = useState<DiffRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [persist, setPersist] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    if (!def) return;
    let live = true;
    readValues(device.handle)
      .then((current) => {
        if (!live) return;
        const r = diffParams(def, current, file.params);
        setRows(r);
        setSelected(new Set(changedKeys(r)));
      })
      .catch((e: unknown) => {
        toast.error(tDevice('settings.readFailed'), { description: describeError(e, lang) });
        onClose();
      });
    return () => {
      live = false;
    };
    // The preview is taken once, when the dialog opens.
  }, []);

  const keys = useMemo(() => (rows ? changedKeys(rows).filter((k) => selected.has(k)) : []), [rows, selected]);
  const changes = rows ? changedKeys(rows).length : 0;
  const skipped = rows ? rows.filter((r) => r.status === 'invalid' || r.status === 'unknown').length : 0;

  const apply = async (): Promise<void> => {
    if (!rows) return;
    setProgress(0);
    const writes = keys.map((k) => ({ key: k, value: file.params[k] as number }));
    const failed = await writeValues(device.handle, writes, (d, n) => setProgress(d / n));
    const ok = keys.filter((k) => !failed.some((f) => f.key === k));
    if (persist && ok.length) await saveDevice(device.handle, true);
    setProgress(null);
    onApplied(ok);
    if (failed.length) toast.error(tDevice('settings.applyPartial', { count: failed.length }), { description: failed.map((f) => `${f.key}: ${f.error}`).join('\n') });
    else toast.success(tDevice(persist ? 'settings.importedSaved' : 'settings.imported', { count: ok.length }));
    onClose();
  };

  const source = file.source;
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      dismissible={progress === null}
      title={tDevice('import.title')}
      footer={
        <>
          <Checkbox checked={persist} onChange={setPersist} label={tDevice('import.persist')} disabled={progress !== null} />
          <span className="dv-flex" />
          <Button variant="ghost" onClick={onClose} disabled={progress !== null}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={Check} disabled={!keys.length || !device.online} loading={progress !== null} onClick={() => void apply()}>
            {tDevice('import.apply', { count: keys.length })}
          </Button>
        </>
      }
    >
      <div className="dv-dialog">
        <dl className="dv-meta">
          <div>
            <dt>{tDevice('import.from')}</dt>
            <dd>
              {source.name || '—'} · #{source.num} · <span className="cy-mono">{source.uid48 || '—'}</span>
            </dd>
          </div>
          <div>
            <dt>{tDevice('import.exported')}</dt>
            <dd className="cy-mono">{file.exportedAt ? new Date(file.exportedAt).toLocaleString(lang) : '—'}</dd>
          </div>
          <div>
            <dt>{tDevice('import.catalog')}</dt>
            <dd className="cy-mono">
              {file.modelKey} · rev {file.catalogRev}
              {def && file.catalogRev !== def.catalogRev ? ` (${tDevice('import.ours', { rev: def.catalogRev })})` : ''}
            </dd>
          </div>
        </dl>
        {rows === null ? (
          <div className="dv-loading">
            <Spinner size={18} /> {tDevice('import.reading')}
          </div>
        ) : (
          <>
            <div className="dv-dialog__bar">
              <span>{tDevice('import.summary', { changes, total: rows.length })}</span>
              {skipped > 0 && <span className="dv-warntext">{tDevice('import.skipped', { count: skipped })}</span>}
              <span className="dv-flex" />
              <Toggle size="sm" checked={onlyDiff} onChange={setOnlyDiff} label={tDevice('import.onlyDiff')} />
            </div>
            <DiffTable
              rows={rows}
              onlyDiff={onlyDiff}
              selected={selected}
              onToggle={(k, on) =>
                setSelected((s) => {
                  const n = new Set(s);
                  if (on) n.add(k);
                  else n.delete(k);
                  return n;
                })
              }
              fromLabel={tDevice('diff.board')}
              toLabel={tDevice('diff.file')}
            />
            {needsReboot(rows, selected) && <p className="dv-note dv-warntext">{tDevice('import.rebootNote')}</p>}
          </>
        )}
        {progress !== null && <ProgressBar value={progress} />}
      </div>
    </Modal>
  );
}
