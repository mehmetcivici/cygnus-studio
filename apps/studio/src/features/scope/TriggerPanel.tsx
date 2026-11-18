import { useEffect, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Crosshair, X } from 'lucide-react';
import { Badge, Button, FormRow, NumberField, Panel, SegmentedControl, Select, type Tone } from '../../ui';
import { TriggerEngine, type TriggerEdge, type TriggerPhase } from './trigger';
import { tScope } from './messages';
import type { PlotSignal } from './types';
import type { ScopeView } from './view';

const PHASE_TONE: Record<TriggerPhase, Tone> = { off: 'neutral', armed: 'warn', waiting: 'accent', done: 'ok' };

/** Single-shot trigger on one plotted signal; freezes the view when the capture is complete. */
export function TriggerPanel({ signals, view }: { signals: readonly PlotSignal[]; view: ScopeView }) {
  const engine = useRef(new TriggerEngine());
  const [sigId, setSigId] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [edge, setEdge] = useState<TriggerEdge>('rising');
  const [pre, setPre] = useState(50);
  const [phase, setPhase] = useState<TriggerPhase>('off');
  const sig = signals.find((s) => s.id === sigId) ?? signals[0];
  const sigRef = useRef(sig);
  sigRef.current = sig;

  useEffect(() => {
    const h = setInterval(() => {
      const e = engine.current;
      if (e.phase === 'off') return;
      const s = sigRef.current;
      const end = e.update(s?.buffer ?? null, view.liveNow());
      if (end !== null) view.pause(end);
      setPhase((p) => (p === e.phase ? p : e.phase));
    }, 25);
    return () => clearInterval(h);
  }, [view]);

  // The trigger signal went away.
  useEffect(() => {
    if (!sig && engine.current.phase !== 'off') {
      engine.current.disarm();
      setPhase('off');
    }
  }, [sig]);

  const arm = (): void => {
    if (!sig) return;
    view.resume();
    engine.current.arm({ level, edge }, view.span, pre / 100, view.liveNow());
    setPhase('armed');
  };
  const cancel = (): void => {
    engine.current.disarm();
    setPhase('off');
  };
  const active = phase === 'armed' || phase === 'waiting';
  const pick = (id: string): void => {
    setSigId(id);
    const s = signals.find((x) => x.id === id);
    const v = s?.buffer?.lastValue;
    if (v !== undefined && Number.isFinite(v)) setLevel(Number(v.toPrecision(3)));
  };

  return (
    <Panel title={tScope('trigger')} actions={<Badge tone={PHASE_TONE[phase]}>{tScope(`phase.${phase}`)}</Badge>}>
      {signals.length === 0 ? (
        <p className="scope-side__hint">{tScope('triggerNoSignal')}</p>
      ) : (
        <div className="scope-form">
          <FormRow layout="vertical" label={tScope('triggerSignal')}>
            <Select<string>
              size="sm"
              value={sig?.id ?? null}
              onChange={pick}
              disabled={active}
              ariaLabel={tScope('triggerSignal')}
              options={signals.map((s) => ({ value: s.id, label: s.label }))}
            />
          </FormRow>
          <FormRow layout="vertical" label={tScope('triggerLevel')}>
            <NumberField size="sm" value={level} onCommit={setLevel} unit={sig?.unit} digits={Math.max(2, sig?.digits ?? 2)} width={150} disabled={active} ariaLabel={tScope('triggerLevel')} />
          </FormRow>
          <FormRow layout="vertical" label={tScope('triggerEdge')}>
            <SegmentedControl<TriggerEdge>
              size="sm"
              value={edge}
              onChange={setEdge}
              disabled={active}
              ariaLabel={tScope('triggerEdge')}
              options={[
                { value: 'rising', icon: ArrowUpRight, label: tScope('edgeRising') },
                { value: 'falling', icon: ArrowDownRight, label: tScope('edgeFalling') },
              ]}
            />
          </FormRow>
          <FormRow layout="vertical" label={tScope('triggerPre')}>
            <NumberField size="sm" value={pre} onCommit={setPre} unit="%" min={0} max={100} step={10} integer width={110} disabled={active} ariaLabel={tScope('triggerPre')} />
          </FormRow>
          <div className="scope-form__actions">
            {active ? (
              <Button size="sm" variant="secondary" icon={X} onClick={cancel}>
                {tScope('triggerCancel')}
              </Button>
            ) : (
              <Button size="sm" variant="primary" icon={Crosshair} onClick={arm}>
                {phase === 'done' ? tScope('triggerRearm') : tScope('triggerArm')}
              </Button>
            )}
          </div>
          <p className="scope-side__hint">{tScope('triggerHint')}</p>
        </div>
      )}
    </Panel>
  );
}
