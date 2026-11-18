import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { useI18n } from '../i18n';
import { Modal, cx } from '../ui';
import { useBusStats, useConnection, useSimulation } from '../core';
import type { SimSnapshot } from '@cygnus/simulator';
import { tShell } from './messages';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="cy-health__row">
      <span>{label}</span>
      <span className="cy-mono">{value}</span>
    </div>
  );
}

/** Top bar: load %, frames/s and timeouts; click for the detail sheet. */
export function BusHealth() {
  const { fmtNumber, fmtPercent, t } = useI18n();
  const stats = useBusStats();
  const phase = useConnection((s) => s.phase);
  const fd = useConnection((s) => s.fd);
  const sim = useSimulation();
  const [open, setOpen] = useState(false);
  const [simBus, setSimBus] = useState<SimSnapshot['bus'] | null>(null);
  useEffect(() => {
    if (!open || !sim) return;
    const read = (): void => setSimBus(sim.snapshot().bus);
    read();
    const h = setInterval(read, 500);
    return () => clearInterval(h);
  }, [open, sim]);
  if (phase === 'idle' || !stats) return null;
  const load = stats.loadPct;
  const tone = load > 80 ? 'danger' : load > 60 ? 'caution' : 'ok';
  const fps = stats.rxFps + stats.txFps;
  return (
    <>
      <button type="button" className={cx('cy-health', `is-${tone}`)} onClick={() => setOpen(true)} title={tShell('health.title')}>
        <Activity size={15} aria-hidden />
        <span className="cy-health__load">
          <span className="cy-health__bar">
            <span style={{ width: `${Math.min(100, load)}%` }} />
          </span>
          <span className="cy-mono">{fmtPercent(load, 0)}</span>
        </span>
        <span className="cy-health__sep" />
        <span className="cy-mono">{fmtNumber(fps, 0)}</span>
        <span className="cy-health__unit">{tShell('health.fps')}</span>
        {stats.requestTimeouts > 0 && (
          <>
            <span className="cy-health__sep" />
            <span className="cy-health__warn cy-mono">{stats.requestTimeouts}</span>
            <span className="cy-health__unit">{tShell('health.timeouts')}</span>
          </>
        )}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={tShell('health.title')} size="sm">
        <div className="cy-health__sheet">
          <Row label={tShell('health.link')} value={fd ? tShell('health.fd') : tShell('health.classic')} />
          <Row label={tShell('health.load')} value={fmtPercent(load, 1)} />
          <Row label={tShell('health.rx')} value={`${fmtNumber(stats.rxFps, 0)} ${tShell('health.fps')}`} />
          <Row label={tShell('health.tx')} value={`${fmtNumber(stats.txFps, 0)} ${tShell('health.fps')}`} />
          <Row label={tShell('health.rxTotal')} value={fmtNumber(stats.rxTotal, 0)} />
          <Row label={tShell('health.txTotal')} value={fmtNumber(stats.txTotal, 0)} />
          <Row label={tShell('health.requestTimeouts')} value={fmtNumber(stats.requestTimeouts, 0)} />
          <Row label={tShell('health.enumTimeouts')} value={fmtNumber(stats.enumTimeouts, 0)} />
          <Row label={tShell('health.window')} value={`${fmtNumber(stats.windowMs, 0)} ms`} />
          {simBus && (
            <>
              <div className="cy-health__section">{tShell('health.sim')}</div>
              <Row label={tShell('health.errorFrames')} value={fmtNumber(simBus.errorFrames, 0)} />
              <Row label={tShell('health.lostFrames')} value={fmtNumber(simBus.lostFrames, 0)} />
              <Row label={tShell('health.terminations')} value={String(simBus.terminations)} />
              <Row label={tShell('health.shorted')} value={simBus.shorted ? t('common.yes') : t('common.no')} />
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
