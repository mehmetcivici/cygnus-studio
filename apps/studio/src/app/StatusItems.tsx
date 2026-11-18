import { useEffect, useState } from 'react';
import { Circle, Hourglass, RotateCw, TriangleAlert } from 'lucide-react';
import { useI18n } from '../i18n';
import { StatusDot, type DeviceStatus } from '../ui';
import { useBusy, useConnection, useDevices, useRecorder, useUnresolved, type ConnectionPhase } from '../core';
import { useStatusItems } from '../core/statusItems';
import { navigate } from './nav';
import { useSourceLabel } from './ConnectionMenu';
import { useLinkHealth } from './AlertCenter';
import { tShell } from './messages';

const DOT: Record<ConnectionPhase, DeviceStatus> = { idle: 'offline', connecting: 'boot', connected: 'ok', lost: 'fault', error: 'fault' };

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function RecordingItem() {
  const { fmtNumber } = useI18n();
  const rec = useRecorder();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!rec.recording) return;
    const h = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(h);
  }, [rec.recording]);
  if (!rec.recording || rec.startedAt === null) return null;
  return (
    <span className="cy-statusbar__item cy-rec">
      <Circle size={9} fill="currentColor" aria-hidden />
      {tShell('status.recording', { time: fmtDuration(now - rec.startedAt), samples: fmtNumber(rec.samples, 0) })}
    </span>
  );
}

/** Busy locks (firmware update …): leaving / disconnecting asks first. */
function BusyItems() {
  const { t } = useI18n();
  const locks = useBusy((s) => s.locks);
  return (
    <>
      {locks.map((l) => (
        <span key={l.id} className="cy-statusbar__item cy-statusbar__warn" role="status">
          <Hourglass size={12} aria-hidden />
          {t(l.reasonKey, l.params)}
        </span>
      ))}
    </>
  );
}

/** Items published by screens through `useStatusItem`. */
function ScreenItems() {
  const items = useStatusItems((s) => s.items);
  const list = Object.entries(items).sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0));
  return (
    <>
      {list.map(([id, it]) =>
        it.onClick ? (
          <button key={id} type="button" className={`cy-statusbar__item is-${it.tone ?? 'neutral'}`} title={it.title} onClick={it.onClick}>
            {it.text}
          </button>
        ) : (
          <span key={id} className={`cy-statusbar__item is-${it.tone ?? 'neutral'}`} title={it.title}>
            {it.text}
          </span>
        ),
      )}
    </>
  );
}

/** Demo motion is on: the flywheel turns by "hand", not by a motor command. */
function AmbientItem() {
  const ambient = useConnection((s) => s.ambient);
  if (!ambient) return null;
  return (
    <span className="cy-statusbar__item" title={tShell('status.ambientHint')}>
      <RotateCw size={11} aria-hidden />
      {tShell('status.ambient')}
    </span>
  );
}

/** Status bar, left: link, board count, unresolved warning, recording. */
export function StatusLeft() {
  const { t } = useI18n();
  const phase = useConnection((s) => s.phase);
  const label = useSourceLabel();
  const devices = useDevices();
  const unresolved = useUnresolved();
  const online = devices.filter((d) => d.online).length;
  const health = useLinkHealth();
  return (
    <>
      <span className="cy-statusbar__item">
        <StatusDot status={phase === 'connected' && health !== 'ok' ? health : DOT[phase]} size={7} />
        {t(`core.conn.phase.${phase}`)}
        {phase !== 'idle' && label && <span className="cy-statusbar__muted">· {label}</span>}
      </span>
      {phase !== 'idle' && <span className="cy-statusbar__item">{tShell('status.devices', { online, count: devices.length })}</span>}
      {unresolved.length > 0 && (
        <button type="button" className="cy-statusbar__item cy-statusbar__warn" onClick={() => navigate('bus')}>
          <TriangleAlert size={12} aria-hidden />
          {tShell('status.unresolved', { count: unresolved.length })}
        </button>
      )}
      <RecordingItem />
      <BusyItems />
      <AmbientItem />
      <ScreenItems />
    </>
  );
}
