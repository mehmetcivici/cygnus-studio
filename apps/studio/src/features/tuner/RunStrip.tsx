import { useMemo } from 'react';
import { Braces, Check, FileSpreadsheet, GitCompareArrows, RotateCcw, Star, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button, Checkbox, IconButton, Sparkline, Tooltip, cx } from '../../ui';
import { downloadFile, safeFileName } from '../../core';
import { useTuner } from './controller';
import { setUi, toggleSelected, useTunerUi } from './state';
import { headline, runLabelKey, runsToCsv, runsToJson } from './runs';
import { removeRuns } from './project';
import { bestRun } from './CenterColumn';
import type { TunerRun } from './types';
import { tTuner } from './messages';

export function RunStrip() {
  const { lang } = useI18n();
  const api = useTuner();
  const selected = useTunerUi((s) => s.selected);
  const focus = useTunerUi((s) => s.focus);
  const runs = api.runs;
  const sel = runs.filter((r) => selected.includes(r.id));
  const best = useMemo(() => bestRun(runs), [runs]);
  const exportRuns = sel.length ? sel : runs;
  const base = safeFileName(`${api.view.name || api.ctx.def.key}-${api.ctx.loop.key}`);
  return (
    <div className="tuner-strip">
      <div className="tuner-strip__head">
        <h3>{tTuner('runs.title', { n: runs.length })}</h3>
        <span className="tuner-muted">{runs.length ? tTuner('runs.hint') : ''}</span>
        <span className="tuner-strip__spacer" />
        <Button size="sm" icon={GitCompareArrows} disabled={sel.length === 0} onClick={() => setUi({ view: 'compare' })}>
          {tTuner('runs.compare', { n: sel.length })}
        </Button>
        <IconButton
          size="sm"
          icon={FileSpreadsheet}
          label={tTuner('runs.csv')}
          disabled={!exportRuns.length}
          onClick={() => downloadFile(`${base}.csv`, runsToCsv(exportRuns, lang === 'tr'), 'text/csv')}
        />
        <IconButton size="sm" icon={Braces} label={tTuner('runs.json')} disabled={!exportRuns.length} onClick={() => downloadFile(`${base}.json`, runsToJson(exportRuns), 'application/json')} />
        <IconButton
          size="sm"
          icon={Trash2}
          label={tTuner('runs.delete', { n: sel.length })}
          disabled={!sel.length}
          onClick={() => {
            removeRuns(new Set(selected));
            setUi({ selected: [], focus: null });
          }}
        />
      </div>
      {runs.length === 0 ? (
        <Guide />
      ) : (
        <div className="tuner-strip__list" role="list">
          {[...runs].reverse().map((r) => (
            <RunCard key={r.id} run={r} selected={selected.includes(r.id)} focused={r.id === focus} best={r.id === best} />
          ))}
        </div>
      )}
    </div>
  );
}

function RunCard({ run, selected, focused, best }: { run: TunerRun; selected: boolean; focused: boolean; best: boolean }) {
  const { fmtValue, fmtNumber } = useI18n();
  const api = useTuner();
  const m = headline(run);
  const values = useMemo(() => {
    const y = run.data.measured;
    const step = Math.max(1, Math.floor(y.length / 60));
    const out: number[] = [];
    for (let i = 0; i < y.length; i += step) out.push(y[i]!);
    return out;
  }, [run]);
  const a = run.analysis;
  const line = m
    ? `${fmtValue(m.overshoot, '%', 0)} · ${Number.isNaN(m.settlingTime) ? '—' : fmtValue(m.settlingTime, 's', 2)}`
    : a.ff
      ? `R² ${fmtNumber(a.ff.r2, 3)}`
      : a.relay
        ? `Ku ${fmtNumber(a.relay.ku, 3)}`
        : a.bode
          ? `PM ${fmtValue(a.bode.margins.phaseMarginDeg, '°', 0)}`
          : a.model
            ? `R² ${fmtNumber(a.model.r2, 3)}`
            : '—';
  return (
    <div
      role="listitem"
      className={cx('tuner-run', selected && 'is-selected', focused && 'is-focused')}
      onClick={() => setUi({ focus: run.id, rightTab: run.analysis.bode ? 'freq' : run.analysis.steps.length ? 'metrics' : 'assist' })}
    >
      <div className="tuner-run__top">
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={selected} onChange={() => toggleSelected(run.id)} ariaLabel={tTuner('runs.select', { n: run.n })} />
        </span>
        <span className="tuner-run__n">#{run.n}</span>
        {run.gainSet && <span className="tuner-set">{run.gainSet}</span>}
        <span className="tuner-run__kind">{tTuner(runLabelKey(run))}</span>
        {best && (
          <Tooltip content={tTuner('compare.best')}>
            <Star size={13} className="tuner-star" aria-label={tTuner('compare.best')} />
          </Tooltip>
        )}
      </div>
      <Sparkline values={values} height={26} color={selected ? 'var(--cy-accent)' : undefined} />
      <div className="tuner-run__bottom">
        <span className="cy-mono">{line}</span>
        <span onClick={(e) => e.stopPropagation()}>
          <IconButton size="sm" variant="ghost" icon={RotateCcw} label={tTuner('runs.restore')} disabled={!api.view.online} onClick={() => void api.writeGains(run.gains)} />
        </span>
      </div>
      {run.note && <div className="tuner-run__note" title={run.note}>{run.note}</div>}
    </div>
  );
}

function Guide() {
  const api = useTuner();
  const hasClosed = api.runs.some((r) => r.kind === 'closed');
  const steps = [
    { n: 1, title: tTuner('guide.s1'), body: tTuner('guide.s1b'), done: true },
    { n: 2, title: tTuner('guide.s2'), body: tTuner('guide.s2b'), done: hasClosed },
    { n: 3, title: tTuner('guide.s3'), body: tTuner('guide.s3b'), done: false },
  ];
  return (
    <ol className="tuner-guide" aria-label={tTuner('guide.title')}>
      {steps.map((s) => (
        <li key={s.n} className={cx(s.done && 'is-done')}>
          <span className="tuner-guide__n">{s.done ? <Check size={13} /> : s.n}</span>
          <span>
            <strong>{s.title}</strong>
            <span>{s.body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
