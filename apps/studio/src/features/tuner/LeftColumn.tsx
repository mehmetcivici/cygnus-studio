import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Info, RotateCcw, Save, Undo2, Workflow } from 'lucide-react';
import type { GainRole, ParamDef } from '@cygnus/protocol';
import { signalByKey } from '@cygnus/protocol';
import { useI18n } from '../../i18n';
import { Badge, IconButton, NumberField, Panel, SegmentedControl, Slider, Tooltip, cx } from '../../ui';
import { DevicePicker, ParamField } from '../../core';
import { navigate } from '../../app/nav';
import { isTunable, useTuner } from './controller';
import { ROLE_SYMBOL, cascadeOf, gainParam } from './loop';
import { baseline, historyDepth, setUi, useHistoryVersion } from './state';
import type { GainSetId } from './types';
import { tTuner } from './messages';

export function LeftColumn() {
  return (
    <div className="tuner__left">
      <DeviceLoopPanel />
      <GainPanel />
    </div>
  );
}

export function DeviceLoopPanel() {
  const { tl, fmtValue } = useI18n();
  const api = useTuner();
  const { view, ctx } = api;
  const def = view.def!;
  const cascades = useMemo(() => cascadeOf(def), [def]);
  const outUnit = ctx.outputUnit;
  return (
    <Panel title={tTuner('left.title')} icon={Workflow} padding="sm">
      <div className="tuner-dev">
        <DevicePicker
          value={view.uid48}
          where={isTunable}
          width="100%"
          size="sm"
          disabled={api.armed}
          onChange={(uid) => {
            setUi({ uid, loopKey: null });
            navigate('tuner', { device: uid });
          }}
        />
        <div className="tuner-loops" role="listbox" aria-label={tTuner('left.loops')}>
          {def.tuner.loops.map((l, i) => {
            const active = l.key === ctx.loop.key;
            const m = signalByKey(def, l.signals.measured);
            const inner = cascades.find((c) => c.outer === l.key)?.inner;
            return (
              <button
                key={l.key}
                type="button"
                role="option"
                aria-selected={active}
                disabled={api.armed && !active}
                className={cx('tuner-loop', active && 'is-active')}
                onClick={() => setUi({ loopKey: l.key, focus: null, selected: [] })}
              >
                <span className="tuner-loop__idx">{i + 1}</span>
                <span className="tuner-loop__body">
                  <span className="tuner-loop__name">{tl(l.label)}</span>
                  <span className="tuner-loop__meta">
                    {m ? tl(m.label) : l.signals.measured} · {l.unit}
                    {inner ? ` → ${tl(def.tuner.loops.find((x) => x.key === inner)?.label)}` : ''}
                  </span>
                </span>
                <ArrowRight size={13} className="tuner-loop__arrow" aria-hidden />
              </button>
            );
          })}
          <div className="tuner-loops__out">
            <span>{tTuner('left.output', { unit: outUnit || '—' })}</span>
            {ctx.currentLimitParam && api.currentLimit !== undefined && (
              <Badge tone="caution" size="sm">
                {tTuner('left.currentLimit', { value: fmtValue(api.currentLimit, ctx.currentUnit, 0) })}
              </Badge>
            )}
          </div>
        </div>
        <Tooltip content={cascades.length ? tTuner('left.innerFirstLong') : tTuner('left.parallelLong', { unit: outUnit || '—' })}>
          <p className="tuner-hint">
            <Info size={13} aria-hidden />
            <span>
              {cascades.length
                ? tTuner('left.innerFirst', { inner: tl(def.tuner.loops.find((l) => l.key === cascades[0]!.inner)?.label) })
                : tTuner('left.parallel', { unit: outUnit || '—' })}
            </span>
          </p>
        </Tooltip>
      </div>
    </Panel>
  );
}

function shortLabel(p: ParamDef, tl: (t: { tr: string; en: string }) => string): string {
  const s = tl(p.label);
  const i = s.lastIndexOf(' · ');
  return i >= 0 ? s.slice(i + 3) : s;
}


export function GainPanel() {
  const api = useTuner();
  const { ctx, view } = api;
  useHistoryVersion();
  const depth = historyDepth(api.id);
  const base = baseline(api.id);
  const disabled = !view.online || api.testing;
  return (
    <Panel title={tTuner('gains.title')} padding="sm" fill className="tuner-gains">
      <div className="tuner-gains__bar">
        <Tooltip content={tTuner('gains.abHint')}>
          <span>
            <SegmentedControl<GainSetId>
              size="sm"
              value={api.sets.active}
              onChange={(s) => void api.switchSet(s)}
              disabled={disabled}
              ariaLabel={tTuner('gains.ab')}
              options={[
                { value: 'A', label: 'A' },
                { value: 'B', label: 'B' },
              ]}
            />
          </span>
        </Tooltip>
        <span className="tuner-gains__spacer" />
        <IconButton size="sm" icon={Undo2} label={tTuner('gains.undo', { n: depth })} disabled={disabled || depth === 0} onClick={() => void api.undo()} />
        <IconButton size="sm" icon={RotateCcw} label={tTuner('gains.revert')} disabled={disabled || !base} onClick={() => void api.revert()} />
        <IconButton size="sm" icon={Save} label={tTuner('gains.save')} variant={view.flags.unsaved ? 'primary' : 'secondary'} disabled={disabled} onClick={() => void api.save()} />
      </div>
      <p className="tuner-muted tuner-gains__ram">{tTuner('gains.ram')}</p>
      <div className="tuner-gains__list">
        {ctx.roles.map((role) => {
          const p = gainParam(ctx, role);
          if (!p) return null;
          return <GainRow key={role} role={role} param={p} disabled={disabled} />;
        })}
        {(ctx.loop.extraParams ?? []).length > 0 && (
          <div className="tuner-gains__extra">
            <span className="tuner-label">{tTuner('gains.extra')}</span>
            {(ctx.loop.extraParams ?? []).map((k) => (
              <ParamField key={k} uid48={view.uid48} paramKey={k} mode="immediate" compact showKey={false} layout="vertical" />
            ))}
          </div>
        )}
        {view.flags.unsaved && <p className="tuner-hint tuner-hint--warn">{tTuner('gains.unsavedHint')}</p>}
      </div>
    </Panel>
  );
}

/** Ratio range of the fine slider: ×¼ … ×4 around the value at drag start. */
const FINE = Math.log(4);

function GainRow({ role, param, disabled }: { role: GainRole; param: ParamDef; disabled: boolean }) {
  const { tl, fmtNumber } = useI18n();
  const api = useTuner();
  const value = api.gains[role];
  const [drag, setDrag] = useState<number | null>(null);
  const anchor = useRef(value ?? 0);
  useEffect(() => {
    if (drag === null) anchor.current = value ?? 0;
  }, [value, drag]);
  const fromSlider = (s: number): number => {
    const a = anchor.current;
    let v: number;
    if (a > 0) v = a * Math.exp(s * FINE);
    else {
      // From zero the slider ramps linearly up to a typical magnitude for the parameter.
      const typical = Math.max(param.step * 20, Math.abs(param.default) * 2, param.max * 1e-3);
      v = Math.max(0, s) * typical;
    }
    const q = param.step > 0 ? Math.round(v / param.step) * param.step : v;
    return Math.min(param.max, Math.max(param.min, Number(q.toPrecision(6))));
  };
  const shown = drag ?? value ?? null;
  const commit = (v: number): void => {
    void api.writeGains({ [role]: v });
  };
  return (
    <div className={cx('tuner-gain', drag !== null && 'is-dragging')}>
      <div className="tuner-gain__head">
        <span className="tuner-gain__sym">{ROLE_SYMBOL[role]}</span>
        {shortLabel(param, tl).toLowerCase() !== ROLE_SYMBOL[role].toLowerCase() && (
          <span className="tuner-gain__label" title={tl(param.help)}>
            {shortLabel(param, tl)}
          </span>
        )}
        {drag !== null && <span className="tuner-gain__live cy-mono">{fmtNumber(drag, Math.min(8, param.digits + 1))}</span>}
      </div>
      <NumberField
        value={shown}
        onCommit={commit}
        unit={param.unit}
        min={param.min}
        max={param.max}
        step={param.step}
        digits={param.digits}
        size="sm"
        width="100%"
        disabled={disabled}
        ariaLabel={tl(param.label)}
      />
      <Slider
        value={drag === null ? 0 : sliderOf(drag, anchor.current, param)}
        min={-1}
        max={1}
        step={0.005}
        bipolar
        disabled={disabled || value === undefined}
        ariaLabel={`${tl(param.label)} · ${tTuner('gains.fine')}`}
        onChange={(s) => setDrag(fromSlider(s))}
        onCommit={(s) => {
          const v = fromSlider(s);
          setDrag(null);
          if (v !== value) commit(v);
        }}
      />
    </div>
  );
}

function sliderOf(v: number, anchor: number, p: ParamDef): number {
  if (anchor > 0 && v > 0) return Math.max(-1, Math.min(1, Math.log(v / anchor) / FINE));
  const typical = Math.max(p.step * 20, Math.abs(p.default) * 2, p.max * 1e-3);
  return Math.max(0, Math.min(1, v / typical));
}

/** Narrow layouts: board and loop in one row above the charts (the gains move to a tab). */
export function CompactLoopBar() {
  const { tl } = useI18n();
  const api = useTuner();
  const { view, ctx } = api;
  const def = view.def!;
  const cascades = cascadeOf(def);
  return (
    <div className="tuner-compact">
      <DevicePicker
        value={view.uid48}
        where={isTunable}
        width={210}
        size="sm"
        disabled={api.armed}
        onChange={(uid) => {
          setUi({ uid, loopKey: null });
          navigate('tuner', { device: uid });
        }}
      />
      <SegmentedControl<string>
        size="sm"
        value={ctx.loop.key}
        disabled={api.armed}
        onChange={(k) => setUi({ loopKey: k, focus: null, selected: [] })}
        ariaLabel={tTuner('left.loops')}
        options={def.tuner.loops.map((l) => ({ value: l.key, label: tl(l.label) }))}
      />
      <Tooltip content={cascades.length ? tTuner('left.innerFirstLong') : tTuner('left.parallelLong', { unit: ctx.outputUnit || '—' })}>
        <Info size={14} className="tuner-compact__info" aria-label={tTuner('left.title')} />
      </Tooltip>
    </div>
  );
}
