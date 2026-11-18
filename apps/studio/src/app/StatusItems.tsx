import { useEffect, useState } from 'react';
import { Circle, TriangleAlert } from 'lucide-react';
import { useI18n } from '../i18n';
import { StatusDot, type DeviceStatus } from '../ui';
import { useConnection, useDevices, useRecorder, useUnresolved, type ConnectionPhase } from '../core';
import { navigate } from './nav';
import { useSourceLabel } from './ConnectionMenu';
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

/** Status bar, left: link, board count, unresolved warning, recording. */
export function StatusLeft() {
  const { t } = useI18n();
  const phase = useConnection((s) => s.phase);
  const label = useSourceLabel();
  const devices = useDevices();
  const unresolved = useUnresolved();
  const online = devices.filter((d) => d.online).length;
  return (
    <>
      <span className="cy-statusbar__item">
        <StatusDot status={DOT[phase]} size={7} />
        {t(`core.conn.phase.${phase}`)}
        {phase !== 'idle' && label && <span className="cy-statusbar__muted">· {label}</span>}
      </span>
      {phase !== 'idle' && <span className="cy-statusbar__item">{tShell('status.devices', { count: online })}</span>}
      {unresolved.length > 0 && (
        <button type="button" className="cy-statusbar__item cy-statusbar__warn" onClick={() => navigate('bus')}>
          <TriangleAlert size={12} aria-hidden />
          {tShell('status.unresolved', { count: unresolved.length })}
        </button>
      )}
      <RecordingItem />
    </>
  );
}
