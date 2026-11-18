import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CircleCheck, CircleX, Copy } from 'lucide-react';
import { paramByKey } from '@cygnus/protocol';
import { useI18n } from '../../../i18n';
import { Badge, Button, Checkbox, Modal, ProgressBar, Spinner, toast, cx } from '../../../ui';
import { DeviceBadge, describeError, matchDevice, useDevices, type DeviceView } from '../../../core';
import { PER_BOARD_KEYS, defaultCopySelection, planCopy } from '../logic/copyPlan';
import { readValues, saveDevice, writeValues } from '../ops';
import { tDevice } from '../messages';
import { DiffTable } from './DiffTable';

type Values = Record<string, number>;
type Result = { ok: number; failed: number; reboot: boolean };

/** Copies this board's settings to other boards of the same model, with a per-target preview. */
export function CopyDialog({ device, onClose }: { device: DeviceView; onClose: () => void }) {
  const { t, tl, lang } = useI18n();
  const def = device.def;
  const devices = useDevices();
  const candidates = useMemo(
    () => devices.filter((d) => d.uid48 !== device.uid48 && matchDevice(d, { capability: 'params', models: def ? [def.key] : [], includeOffline: true })),
    [devices, device.uid48, def],
  );
  const [source, setSource] = useState<Values | null>(null);
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [values, setValues] = useState<Record<string, Values | 'loading' | 'error'>>({});
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [persist, setPersist] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const [results, setResults] = useState<Record<string, Result> | null>(null);

  useEffect(() => {
    if (!def) return;
    let live = true;
    readValues(device.handle)
      .then((v) => {
        if (!live) return;
        setSource(v);
        setSelection(defaultCopySelection(def, v));
      })
      .catch((e: unknown) => {
        toast.error(tDevice('settings.readFailed'), { description: describeError(e, lang) });
        onClose();
      });
    return () => {
      live = false;
    };
    // Source values are taken once, when the dialog opens.
  }, []);

  const toggleTarget = (d: DeviceView, on: boolean): void => {
    setTargets((s) => {
      const n = new Set(s);
      if (on) n.add(d.uid48);
      else n.delete(d.uid48);
      return n;
    });
    if (on && !values[d.uid48]) {
      setValues((v) => ({ ...v, [d.uid48]: 'loading' }));
      readValues(d.handle)
        .then((v) => setValues((cur) => ({ ...cur, [d.uid48]: v })))
        .catch(() => setValues((cur) => ({ ...cur, [d.uid48]: 'error' })));
    }
  };

  const plan = useMemo(() => {
    if (!def || !source) return null;
    const ready = [...targets].flatMap((uid) => {
      const v = values[uid];
      const d = candidates.find((c) => c.uid48 === uid);
      return typeof v === 'object' && d ? [{ uid48: uid, modelKey: d.def?.key, values: v }] : [];
    });
    return planCopy(def, device.uid48, source, ready, selection);
  }, [def, source, targets, values, candidates, device.uid48, selection]);

  if (!def) return null;
  const perBoard = PER_BOARD_KEYS.filter((k) => source?.[k] !== undefined && paramByKey(def, k) && !paramByKey(def, k)?.readOnly);
  const loadingAny = [...targets].some((u) => values[u] === 'loading');

  const apply = async (): Promise<void> => {
    if (!plan || !source) return;
    setProgress(0);
    const out: Record<string, Result> = {};
    const total = Math.max(1, plan.total);
    let done = 0;
    for (const tp of plan.targets) {
      const d = candidates.find((c) => c.uid48 === tp.uid48);
      if (!d || tp.wrongModel) continue;
      const failed = await writeValues(
        d.handle,
        tp.writes.map((k) => ({ key: k, value: source[k] as number })),
        () => setProgress(++done / total),
      );
      const ok = tp.writes.length - failed.length;
      if (persist && ok > 0) await saveDevice(d.handle, true);
      out[tp.uid48] = { ok, failed: failed.length, reboot: tp.writes.some((k) => !failed.some((f) => f.key === k) && paramByKey(def, k)?.rebootRequired) };
    }
    setProgress(null);
    setResults(out);
    const nFail = Object.values(out).reduce((n, r) => n + r.failed, 0);
    if (nFail) toast.error(tDevice('copy.partial', { count: nFail }));
    else toast.success(tDevice('copy.done', { count: Object.keys(out).length }));
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      dismissible={progress === null}
      title={tDevice('copy.title', { model: tl(def.name) })}
      footer={
        results ? (
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        ) : (
          <>
            <Checkbox checked={persist} onChange={setPersist} label={tDevice('copy.persist')} disabled={progress !== null} />
            <span className="dv-flex" />
            <Button variant="ghost" onClick={onClose} disabled={progress !== null}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" icon={Copy} disabled={!plan || plan.total === 0 || loadingAny} loading={progress !== null} onClick={() => void apply()}>
              {tDevice('copy.apply', { count: plan?.total ?? 0 })}
            </Button>
          </>
        )
      }
    >
      <div className="dv-dialog">
        <p className="dv-note">{tDevice('copy.intro')}</p>
        {source === null ? (
          <div className="dv-loading">
            <Spinner size={18} /> {tDevice('import.reading')}
          </div>
        ) : candidates.length === 0 ? (
          <p className="dv-note dv-note--center">{tDevice('copy.noTargets')}</p>
        ) : (
          <>
            <h3 className="dv-dialog__h">{tDevice('copy.targets')}</h3>
            <ul className="dv-targets">
              {candidates.map((d) => {
                const tp = plan?.targets.find((p) => p.uid48 === d.uid48);
                const v = values[d.uid48];
                const res = results?.[d.uid48];
                const checked = targets.has(d.uid48);
                return (
                  <li key={d.uid48} className={cx('dv-target', checked && 'is-checked')}>
                    <div className="dv-target__row">
                      <Checkbox checked={checked} onChange={(on) => toggleTarget(d, on)} disabled={!d.online || progress !== null || !!results} ariaLabel={d.uid48} />
                      <DeviceBadge device={d} size="sm" />
                      <span className="dv-flex" />
                      {checked && v === 'loading' && <Spinner size={14} />}
                      {checked && v === 'error' && <Badge tone="danger" size="sm">{tDevice('copy.readError')}</Badge>}
                      {res ? (
                        <Badge size="sm" tone={res.failed ? 'danger' : 'ok'} icon={res.failed ? CircleX : CircleCheck}>
                          {res.failed ? tDevice('copy.resultFail', { ok: res.ok, failed: res.failed }) : tDevice('copy.resultOk', { count: res.ok })}
                        </Badge>
                      ) : (
                        tp && (
                          <button type="button" className="dv-target__toggle" onClick={() => setOpen(open === d.uid48 ? null : d.uid48)} aria-expanded={open === d.uid48}>
                            {tp.writes.length ? tDevice('copy.changes', { count: tp.writes.length }) : tDevice('copy.same')}
                            {open === d.uid48 ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                          </button>
                        )
                      )}
                      {!d.online && <Badge size="sm">{t('status.offline')}</Badge>}
                    </div>
                    {res?.reboot && <p className="dv-note dv-warntext">{tDevice('copy.rebootNote')}</p>}
                    {tp && open === d.uid48 && !res && <DiffTable rows={tp.rows} onlyDiff fromLabel={tDevice('diff.target')} toLabel={tDevice('diff.source')} maxHeight={240} />}
                  </li>
                );
              })}
            </ul>
            {perBoard.length > 0 && (
              <div className="dv-perboard">
                <h3 className="dv-dialog__h">{tDevice('copy.perBoard')}</h3>
                <p className="dv-note">{tDevice('copy.perBoardHelp')}</p>
                {perBoard.map((k) => {
                  const p = paramByKey(def, k);
                  return (
                    <Checkbox
                      key={k}
                      checked={selection.has(k)}
                      disabled={progress !== null || !!results}
                      onChange={(on) =>
                        setSelection((s) => {
                          const n = new Set(s);
                          if (on) n.add(k);
                          else n.delete(k);
                          return n;
                        })
                      }
                      label={
                        <>
                          {p ? tl(p.label) : k} <span className="cy-mono dv-dim">{k}</span>
                        </>
                      }
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
        {progress !== null && <ProgressBar value={progress} />}
      </div>
    </Modal>
  );
}
