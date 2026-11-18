import { ClipboardCheck, History, RotateCcw, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Badge, Button, Panel, type Tone } from '../../ui';
import { useBus } from '../../core';
import { useFwRows } from './rows';
import { useFwSafety } from './safety';
import { clearRuns, updateMany, useFwLibrary, useFwUpdate, type CardRun, type LogEntry } from './store';
import { tFirmware } from './messages';

const COUNTS: ReadonlyArray<{ key: 'done' | 'skipped' | 'failed' | 'aborted'; label: 'ok' | 'skipped' | 'failed' | 'aborted'; tone: Tone }> = [
  { key: 'done', label: 'ok', tone: 'ok' },
  { key: 'skipped', label: 'skipped', tone: 'neutral' },
  { key: 'failed', label: 'failed', tone: 'danger' },
  { key: 'aborted', label: 'aborted', tone: 'warn' },
];

/** Outcome of the latest run: counts and the reason for every board that did not succeed. */
export function SummaryPanel() {
  const runs = useFwUpdate((s) => s.runs);
  const order = useFwUpdate((s) => s.order);
  const running = useFwUpdate((s) => s.running);
  const images = useFwLibrary((s) => s.images);
  const bus = useBus();
  const safety = useFwSafety();
  const { rows } = useFwRows();
  const list: CardRun[] = order.map((u) => runs[u]).filter((r): r is CardRun => r !== undefined);
  if (running || list.length === 0) return null;
  const count = (k: CardRun['state']): number => list.filter((r) => r.state === k).length;
  const failed = list.filter((r) => r.state === 'failed' || r.state === 'aborted');
  const retry = (): void => {
    if (!bus) return;
    const devices = failed.flatMap((r) => {
      const row = rows.find((x) => x.view.uid48 === r.uid48);
      return row ? [{ device: row.view.handle, name: r.name }] : [];
    });
    void updateMany(bus, devices, images);
  };
  const reasons = list.filter((r) => r.state !== 'done');
  return (
    <Panel
      title={tFirmware('summary.title')}
      icon={ClipboardCheck}
      actions={
        <>
          {failed.length > 0 && (
            <Button size="sm" icon={RotateCcw} disabled={safety.driveActive || !bus} onClick={retry}>
              {tFirmware('summary.retryFailed')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={clearRuns}>
            {tFirmware('act.clearResults')}
          </Button>
        </>
      }
    >
      <div className="fw-summary" data-testid="fw-summary">
        <div className="fw-summary__counts">
          {COUNTS.map((c) => (
            <Badge key={c.key} tone={count(c.key) > 0 ? c.tone : 'neutral'} variant={count(c.key) > 0 ? 'soft' : 'outline'} data-testid={`fw-count-${c.key}`}>
              {tFirmware(`summary.${c.label}`)}: {count(c.key)}
            </Badge>
          ))}
        </div>
        {reasons.length === 0 ? (
          <p className="fw-summary__ok">{tFirmware('summary.allGood')}</p>
        ) : (
          <ul className="fw-summary__list">
            {reasons.map((r) => (
              <li key={r.uid48}>
                <Badge size="sm" tone={r.state === 'failed' ? 'danger' : r.state === 'aborted' ? 'warn' : 'neutral'}>
                  {tFirmware(`run.${r.state}`)}
                </Badge>
                <strong>{r.name}</strong>
                <span>{r.error ?? (r.skip ? tFirmwareSkip(r.skip) : '')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function tFirmwareSkip(s: NonNullable<CardRun['skip']>): string {
  return tFirmware(`skip.${s}`);
}

const OUTCOME_TONE: Record<LogEntry['outcome'], Tone> = { ok: 'ok', failed: 'danger', aborted: 'warn', skipped: 'neutral', retry: 'warn' };

export function LogPanel() {
  const { lang } = useI18n();
  const log = useFwUpdate((s) => s.log);
  const time = (at: number): string => new Date(at).toLocaleTimeString(lang === 'tr' ? 'tr-TR' : 'en-GB');
  return (
    <Panel
      title={tFirmware('log.title')}
      subtitle={log.length || undefined}
      icon={History}
      actions={
        log.length > 0 && (
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => useFwUpdate.setState({ log: [] })}>
            {tFirmware('log.clear')}
          </Button>
        )
      }
    >
      {log.length === 0 ? (
        <p className="fw-log__empty">{tFirmware('log.empty')}</p>
      ) : (
        <ul className="fw-log" data-testid="fw-log">
          {log.map((e) => (
            <li key={e.id}>
              <span className="fw-log__time cy-mono">{time(e.at)}</span>
              <Badge size="sm" tone={OUTCOME_TONE[e.outcome]}>
                {tFirmware(`log.outcome.${e.outcome}`)}
              </Badge>
              <span className="fw-log__name">{e.name}</span>
              <span className="fw-log__ver cy-mono">{tFirmware('run.versions', { from: e.from, to: e.to })}</span>
              <span className="fw-log__detail">{e.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
