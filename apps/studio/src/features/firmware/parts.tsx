import { Check, Circle, CircleAlert, CircleX, Cpu, Info, MinusCircle, TriangleAlert } from 'lucide-react';
import type { FirmwarePhase } from '@cygnus/protocol';
import { useI18n } from '../../i18n';
import { Badge, Checkbox, ProgressBar, Spinner, cx, type Tone } from '../../ui';
import type { CardRun } from './store';
import { LOW_VOLTAGE_V, type CardStatus } from './logic';
import type { FwSafety } from './safety';
import { tFirmware } from './messages';

export const STATUS_TONE: Record<CardStatus, Tone> = {
  upToDate: 'ok',
  updateAvailable: 'accent',
  ahead: 'neutral',
  noImage: 'neutral',
  hwIncompatible: 'warn',
  bootloader: 'caution',
  legacy: 'neutral',
  offline: 'neutral',
};

export function SafetyNotes({ safety, lowOk, onLowOk }: { safety: FwSafety; lowOk: boolean; onLowOk: (v: boolean) => void }) {
  return (
    <>
      {safety.driveActive && (
        <div className="fw-note fw-note--danger" role="alert">
          <CircleAlert size={15} aria-hidden />
          <span>{tFirmware('safety.drive')}</span>
        </div>
      )}
      {safety.lowVoltage && safety.voltage !== null && (
        <div className="fw-note fw-note--warn">
          <TriangleAlert size={15} aria-hidden />
          <div>
            <p>{tFirmware('safety.lowVoltage', { v: safety.voltage.toFixed(1), min: LOW_VOLTAGE_V })}</p>
            <Checkbox checked={lowOk} onChange={onLowOk} label={tFirmware('confirm.lowVoltageCheck')} />
          </div>
        </div>
      )}
      {safety.enabledBoards > 0 && (
        <div className="fw-note">
          <Info size={15} aria-hidden />
          <span>{tFirmware('safety.enabledBoards', { count: safety.enabledBoards })}</span>
        </div>
      )}
    </>
  );
}

const STEPS: readonly Exclude<FirmwarePhase, 'finish'>[] = ['validate', 'enterBootloader', 'erase', 'transfer', 'verify'];
const STEP_OF: Record<FirmwarePhase, number> = { validate: 0, enterBootloader: 1, erase: 2, transfer: 3, finish: 3, verify: 4 };

function StepChips({ run }: { run: CardRun }) {
  const cur = run.state === 'done' ? STEPS.length : run.phase ? STEP_OF[run.phase] : -1;
  const failedAt = run.state === 'failed' || run.state === 'aborted' ? Math.max(cur, 0) : -1;
  return (
    <ol className="fw-steps" aria-label={tFirmware('act.update')}>
      {STEPS.map((p, i) => {
        const done = i < cur;
        const active = i === cur && run.state === 'running';
        const bad = i === failedAt;
        return (
          <li key={p} className={cx('fw-step', done && 'is-done', active && 'is-active', bad && 'is-bad')}>
            <span className="fw-step__mark">{bad ? <CircleX size={12} /> : done ? <Check size={12} strokeWidth={3} /> : active ? <Spinner size={11} /> : <Circle size={10} />}</span>
            {tFirmware(`phase.${p}`)}
          </li>
        );
      })}
    </ol>
  );
}

/** Progress, stages, throughput and outcome of one board's run. */
export function RunBlock({ run }: { run: CardRun }) {
  const { t, fmtNumber } = useI18n();
  const tone: Tone = run.state === 'done' ? 'ok' : run.state === 'failed' ? 'danger' : run.state === 'aborted' ? 'warn' : 'accent';
  return (
    <div className={cx('fw-run', `is-${run.state}`)} data-testid={`fw-run-${run.uid48}`} data-state={run.state}>
      <div className="fw-run__top">
        <Badge size="sm" tone={tone} icon={run.state === 'skipped' ? MinusCircle : undefined}>
          {tFirmware(`run.${run.state}`)}
        </Badge>
        {run.attempt > 1 && (
          <Badge size="sm" tone="warn" mono>
            {tFirmware('run.attempt', { n: run.attempt, max: 3 })}
          </Badge>
        )}
        <span className="fw-run__ver cy-mono">{tFirmware('run.versions', { from: run.from, to: run.to })}</span>
        {run.imageName && <span className="fw-run__file cy-mono">{run.imageName}</span>}
        {run.durationMs !== undefined && <span className="fw-run__stat">{tFirmware('run.duration', { s: fmtNumber(run.durationMs / 1000, 1) })}</span>}
      </div>
      {run.state === 'done' && (
        <div className="fw-run__stats cy-mono">
          <span>{tFirmware('run.speed', { value: fmtNumber(run.rateKBs, 1) })}</span>
          <span>{tFirmware('run.rewinds', { count: run.rewinds })}</span>
        </div>
      )}
      {(run.state === 'running' || ((run.state === 'failed' || run.state === 'aborted') && run.phase !== null)) && run.total > 0 && (
        <>
          <StepChips run={run} />
          <ProgressBar value={run.fraction} tone={tone} size="sm" showPercent />
          <div className="fw-run__stats cy-mono">
            <span>{tFirmware('run.bytes', { sent: fmtNumber(run.sent / 1024, 1), total: fmtNumber(run.total / 1024, 1) })}</span>
            {run.rateKBs > 0 && <span>{tFirmware('run.speed', { value: fmtNumber(run.rateKBs, 1) })}</span>}
            <span>{tFirmware('run.rewinds', { count: run.rewinds })}</span>
            {run.state === 'running' && run.etaS !== null && <span>{tFirmware('run.eta', { s: Math.ceil(run.etaS) })}</span>}
          </div>
        </>
      )}
      {run.state === 'queued' && <ProgressBar value={0} size="sm" />}
      {run.skip && <div className="fw-run__why">{t(`firmware.skip.${run.skip}`)}</div>}
      {run.error && <div className="fw-run__err">{run.error}</div>}
      {run.state === 'aborted' && run.phase && run.phase !== 'validate' && <div className="fw-run__why">{tFirmware('run.abortedBoot')}</div>}
      {run.state === 'done' && run.catalogImage > run.catalogStudio && (
        <div className="fw-note">
          <Info size={14} aria-hidden />
          <span>{tFirmware('run.catalogNote', { image: run.catalogImage, studio: run.catalogStudio })}</span>
        </div>
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: CardStatus }) {
  const hint = status === 'hwIncompatible' || status === 'bootloader' || status === 'legacy' || status === 'noImage' ? tFirmware(`statusHint.${status}`) : undefined;
  return (
    <Badge tone={STATUS_TONE[status]} title={hint} icon={status === 'bootloader' ? Cpu : undefined}>
      {tFirmware(`status.${status}`)}
    </Badge>
  );
}
