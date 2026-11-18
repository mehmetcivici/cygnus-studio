import { useEffect, useState } from 'react';
import { CircleCheck, CircleX, ClipboardCheck, Info, Lightbulb, OctagonX, Play, ShieldAlert, Wrench } from 'lucide-react';
import { DeviceState, type ActionDef, type SelfTestResult } from '@cygnus/protocol';
import { hasMessage, useI18n } from '../../../i18n';
import { Badge, Button, ConfirmDialog, EmptyState, NumberField, Panel, Spinner, toast, cx } from '../../../ui';
import { FaultList, clearEstop, describeError, fmtFw, useDrive, useParam, type DeviceView } from '../../../core';
import { tDevice } from '../messages';

const STATE_NAMES = ['boot', 'bootloader', 'idle', 'active', 'fault', 'estop'] as const;

function stateName(state: number): string {
  const k = STATE_NAMES[state];
  return k ? `${tDevice(`state.${k}`)} (${state})` : String(state);
}

/** Plain-language "what to do" for a fault key; generic text for faults without one. */
function faultHint(key: string): string {
  const k = `device.diag.hint.${key}`;
  return hasMessage(k) ? tDevice(`diag.hint.${key}` as 'diag.hint.generic') : tDevice('diag.hint.generic');
}

function FaultsPanel({ device }: { device: DeviceView }) {
  const { tl } = useI18n();
  const latched = useDrive((s) => s.estopLatched);
  const [busy, setBusy] = useState(false);
  const inEstop = device.state === DeviceState.ESTOP || device.faults.list.some((f) => f.key === 'estop' && f.kind === 'active');
  const unique = device.faults.list.filter((f, i, all) => all.findIndex((g) => g.key === f.key) === i);
  const unlock = async (): Promise<void> => {
    setBusy(true);
    try {
      const refused = await clearEstop();
      if (refused.length) toast.error(tDevice('diag.estopRefused', { count: refused.length }));
      else toast.success(tDevice('diag.estopCleared'));
    } catch (e) {
      toast.error(tDevice('diag.estopRefused', { count: 1 }), { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  if (!device.handle.capabilities.faults) {
    return (
      <Panel title={tDevice('diag.faults')} icon={ShieldAlert}>
        <EmptyState size="sm" title={tDevice('diag.faultsUnsupported')} />
      </Panel>
    );
  }
  return (
    <Panel title={tDevice('diag.faults')} icon={ShieldAlert} subtitle={unique.length ? tDevice('diag.faultCount', { count: unique.length }) : undefined}>
      {(inEstop || latched) && (
        <div className="dv-strip dv-strip--danger">
          <OctagonX size={15} aria-hidden />
          <span>{inEstop ? tDevice('diag.estopBoard') : tDevice('diag.estopLatch')}</span>
          <span className="dv-strip__spacer" />
          <Button size="sm" variant="danger" loading={busy} onClick={() => void unlock()}>
            {tDevice('diag.estopUnlock')}
          </Button>
        </div>
      )}
      <FaultList device={device} clearable />
      {unique.length > 0 && (
        <ul className="dv-hints">
          {unique.map((f) => (
            <li key={f.key} className="dv-hint">
              <Lightbulb size={14} aria-hidden />
              <div>
                <div className="dv-hint__title">{tl(f.label)}</div>
                <div className="dv-hint__body">{faultHint(f.key)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function SelfTestPanel({ device }: { device: DeviceView }) {
  const { tl, lang } = useI18n();
  const bits = device.def?.selfTestBits ?? [];
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ r: SelfTestResult; at: Date } | null>(null);
  if (!bits.length || !device.handle.capabilities.commands) return null;
  const run = async (): Promise<void> => {
    setRunning(true);
    try {
      const r = await device.handle.selfTest();
      setResult({ r, at: new Date() });
      if (r.passed) toast.success(tDevice('diag.selfTestPassed'));
      else toast.warn(tDevice('diag.selfTestFailed', { count: r.failed.length }));
    } catch (e) {
      toast.error(tDevice('diag.selfTestError'), { description: describeError(e, lang) });
    } finally {
      setRunning(false);
    }
  };
  return (
    <Panel
      title={tDevice('diag.selfTest')}
      icon={ClipboardCheck}
      subtitle={result ? result.at.toLocaleTimeString(lang) : undefined}
      actions={
        <Button size="sm" variant="primary" icon={Play} loading={running} disabled={!device.online || device.flags.enabled} onClick={() => void run()}>
          {result ? tDevice('diag.selfTestAgain') : tDevice('diag.selfTestRun')}
        </Button>
      }
    >
      {result && (
        <div className={cx('dv-strip', result.r.passed ? 'dv-strip--ok' : 'dv-strip--danger')}>
          {result.r.passed ? <CircleCheck size={15} aria-hidden /> : <CircleX size={15} aria-hidden />}
          <span>{result.r.passed ? tDevice('diag.selfTestPassed') : tDevice('diag.selfTestFailed', { count: result.r.failed.length })}</span>
          <span className="dv-strip__spacer" />
          <span className="cy-mono dv-dim">mask 0x{result.r.mask.toString(16).padStart(2, '0')}</span>
        </div>
      )}
      <table className="dv-table dv-table--plain">
        <thead>
          <tr>
            <th className="is-num">{tDevice('diag.bit')}</th>
            <th>{tDevice('diag.check')}</th>
            <th>{tDevice('diag.result')}</th>
          </tr>
        </thead>
        <tbody>
          {bits.map((b) => {
            const failed = result ? (result.r.mask & (1 << b.bit)) !== 0 : null;
            return (
              <tr key={b.key} className={cx(failed && 'is-bad')}>
                <td className="is-num cy-mono">{b.bit}</td>
                <td>
                  <div className="dv-table__label">{tl(b.label)}</div>
                  {b.help && <div className="dv-table__key">{tl(b.help)}</div>}
                </td>
                <td>
                  {failed === null ? (
                    <span className="dv-dim">{running ? <Spinner size={12} /> : '—'}</span>
                  ) : failed ? (
                    <Badge tone="danger" size="sm" icon={CircleX}>
                      {tDevice('diag.fail')}
                    </Badge>
                  ) : (
                    <Badge tone="ok" size="sm" icon={CircleCheck}>
                      {tDevice('diag.pass')}
                    </Badge>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

function ActionRow({ device, action }: { device: DeviceView; action: ActionDef }) {
  const { tl, lang, fmtNumber } = useI18n();
  const [arg, setArg] = useState(action.arg?.default ?? 0);
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [ticks, setTicks] = useState(0);
  const run = async (): Promise<void> => {
    setConfirm(false);
    setRunning(true);
    setTicks(0);
    try {
      const r = await device.handle.command(action.key, action.arg ? arg : 0, { onProgress: () => setTicks((n) => n + 1) });
      toast.success(tDevice('diag.actionDone', { action: tl(action.label) }), { description: r.result ? tDevice('diag.actionResult', { value: fmtNumber(r.result, 0) }) : undefined });
    } catch (e) {
      toast.error(tDevice('diag.actionFailed', { action: tl(action.label) }), { description: describeError(e, lang) });
    } finally {
      setRunning(false);
    }
  };
  return (
    <li className="dv-action">
      <div className="dv-action__text">
        <div className="dv-action__title">
          {tl(action.label)}
          {action.confirm && (
            <Badge size="sm" tone="caution">
              {tDevice('diag.needsConfirm')}
            </Badge>
          )}
          {action.longRunning && <Badge size="sm">{tDevice('diag.long')}</Badge>}
        </div>
        <div className="dv-action__help">{tl(action.help)}</div>
        {running && action.longRunning && (
          <div className="dv-action__progress">
            <Spinner size={12} /> {tDevice('diag.inProgress', { n: ticks })}
          </div>
        )}
      </div>
      {action.arg && (
        <NumberField value={arg} onCommit={setArg} min={action.arg.min} max={action.arg.max} unit={action.arg.unit} size="sm" width={130} ariaLabel={tl(action.arg.label)} />
      )}
      <Button size="sm" variant={action.confirm ? 'secondary' : 'ghost'} icon={Play} loading={running} disabled={!device.online} onClick={() => (action.confirm ? setConfirm(true) : void run())}>
        {tDevice('diag.run')}
      </Button>
      <ConfirmDialog
        open={confirm}
        tone="danger"
        title={tl(action.label)}
        message={tl(action.help)}
        confirmLabel={tDevice('diag.run')}
        onConfirm={() => void run()}
        onCancel={() => setConfirm(false)}
      />
    </li>
  );
}

function ActionsPanel({ device }: { device: DeviceView }) {
  const actions = device.def?.actions ?? [];
  return (
    <Panel title={tDevice('diag.actions')} icon={Wrench}>
      {!device.handle.capabilities.commands || actions.length === 0 ? (
        <EmptyState size="sm" title={tDevice('diag.noActions')} />
      ) : (
        <ul className="dv-actions">
          {actions.map((a) => (
            <ActionRow key={a.key} device={device} action={a} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function PeriodCell({ uid48, index, fallback }: { uid48: string; index: number; fallback: number }) {
  const p = useParam(uid48, `status.${index}.period_ms`);
  return <span className="cy-mono">{p.def ? `${p.value ?? '…'} ms` : `${fallback} ms`}</span>;
}

function InfoPanel({ device }: { device: DeviceView }) {
  const { tl } = useI18n();
  const h = device.handle;
  const def = device.def;
  const timeout = useParam(device.uid48, 'ctrl.timeout_ms');
  // INFO fields live on the handle only; refresh them whenever the board's view changes.
  const [info, setInfo] = useState(() => ({ uid96: h.uid96, build: h.build, catalogRev: h.catalogRev }));
  useEffect(() => setInfo({ uid96: h.uid96, build: h.build, catalogRev: h.catalogRev }), [device, h]);
  const build = info.build;
  const buildDate = build ? new Date(Date.UTC(2026, 0, 1) + build.buildDay * 86_400_000).toISOString().slice(0, 10) : null;
  const caps = Object.entries(h.capabilities);
  const rows: Array<[string, string]> = [
    [tDevice('info.uid48'), device.uid48],
    [tDevice('info.uid96'), info.uid96 ?? '—'],
    [tDevice('info.model'), `${def?.key ?? '?'} · ${device.model} · devType ${device.devType}`],
    [tDevice('info.num'), String(device.num)],
    [tDevice('info.fw'), device.fw ? fmtFw(device.fw) : '—'],
    [tDevice('info.build'), build ? `${build.gitHash.toString(16).padStart(8, '0')}${build.dirty ? '+dirty' : ''} · ${buildDate}` : '—'],
    [tDevice('info.hw'), device.hwRev !== null ? String(device.hwRev) : '—'],
    [tDevice('info.catalog'), `${info.catalogRev ?? '—'} / ${def?.catalogRev ?? '—'}`],
    [tDevice('info.driver'), device.driver],
    [tDevice('info.state'), stateName(device.state)],
  ];
  if (timeout.def) rows.push([tDevice('info.ctrlTimeout'), `${timeout.value ?? '…'} ms`]);
  return (
    <Panel title={tDevice('info.title')} icon={Info}>
      <dl className="dv-info">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="cy-mono">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="dv-caps">
        {caps.map(([k, on]) => (
          <Badge key={k} size="sm" tone={on ? 'ok' : 'neutral'} variant={on ? 'soft' : 'outline'} mono>
            {k}
          </Badge>
        ))}
      </div>
      {def && def.statusFrames.length > 0 && (
        <>
          <h3 className="dv-dialog__h">{tDevice('info.status')}</h3>
          <table className="dv-table dv-table--plain">
            <thead>
              <tr>
                <th className="is-num">#</th>
                <th>{tDevice('info.frame')}</th>
                <th className="is-num">{tDevice('info.period')}</th>
                <th className="is-num">{tDevice('info.default')}</th>
              </tr>
            </thead>
            <tbody>
              {def.statusFrames.map((f) => (
                <tr key={f.index}>
                  <td className="is-num cy-mono">{f.index}</td>
                  <td>{tl(f.label)}</td>
                  <td className="is-num">
                    <PeriodCell uid48={device.uid48} index={f.index} fallback={f.defaultPeriodMs} />
                  </td>
                  <td className="is-num cy-mono dv-dim">{f.defaultPeriodMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dv-note">
            {tDevice('info.stream', { min: def.stream.minPeriodUs })}
          </p>
        </>
      )}
    </Panel>
  );
}

/** Actions, self-test, faults with hints, E-STOP unlock and raw identity/INFO data. */
export function DiagnosticsTab({ device }: { device: DeviceView }) {
  return (
    <div className="dv-diag">
      <div className="dv-diag__col">
        <FaultsPanel device={device} />
        <SelfTestPanel device={device} />
      </div>
      <div className="dv-diag__col">
        <ActionsPanel device={device} />
        <InfoPanel device={device} />
      </div>
    </div>
  );
}
