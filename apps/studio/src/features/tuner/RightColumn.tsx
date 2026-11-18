import { useMemo } from 'react';
import { BatteryLow, CircleCheck, FlaskConical, Gauge, Play, Save, ShieldOff, SlidersHorizontal, TriangleAlert, Wand2, Waves } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button, Tabs, Tooltip } from '../../ui';
import { ArmButton, useSignal } from '../../core';
import { useTuner } from './controller';
import { setUi, useParamValues, useTunerUi, type RightTab } from './state';
import { TestTab } from './TestTab';
import { MetricsTab } from './MetricsTab';
import { AssistTab } from './AssistTab';
import { FreqTab } from './FreqTab';
import { GainPanel } from './LeftColumn';
import { tTuner } from './messages';

export function RightColumn({ withGains }: { withGains: boolean }) {
  const stored = useTunerUi((s) => s.rightTab);
  const tab: RightTab = !withGains && stored === 'gains' ? 'test' : stored;
  return (
    <div className="tuner__right">
      <ArmCard />
      <Tabs<RightTab>
        variant="line"
        value={tab}
        onChange={(v) => setUi({ rightTab: v })}
        ariaLabel={tTuner('right.tabs')}
        className="tuner-tabs"
        items={[
          ...(withGains ? [{ id: 'gains' as const, label: <span className="tuner-tab-label">{tTuner('right.gains')}</span>, icon: SlidersHorizontal }] : []),
          { id: 'test', label: <span className="tuner-tab-label">{tTuner('right.test')}</span>, icon: FlaskConical },
          { id: 'metrics', label: <span className="tuner-tab-label">{tTuner('right.metrics')}</span>, icon: Gauge },
          { id: 'assist', label: <span className="tuner-tab-label">{tTuner('right.assist')}</span>, icon: Wand2 },
          { id: 'freq', label: <span className="tuner-tab-label">{tTuner('right.freq')}</span>, icon: Waves },
        ]}
      />
      <div className="tuner__tab" key={tab}>
        {tab === 'gains' && <GainPanel />}
        {tab === 'test' && <TestTab />}
        {tab === 'metrics' && <MetricsTab />}
        {tab === 'assist' && <AssistTab />}
        {tab === 'freq' && <FreqTab />}
      </div>
    </div>
  );
}

type Warning = { key: 'battery' | 'unsaved' | 'fault' | 'softLimit'; icon: typeof BatteryLow; params?: Record<string, string | number> };

/** Pre-arm checklist from catalog conventions: supply voltage, unsaved flag, faults, soft limits. */
function useWarnings(): Warning[] {
  const { fmtValue } = useI18n();
  const api = useTuner();
  const { view, ctx } = api;
  const def = ctx.def;
  const vSig = useMemo(() => def.signals.find((s) => s.unit === 'V' && /volt/.test(s.key))?.key ?? '', [def]);
  const volts = useSignal(view.uid48, vSig);
  const keys = useMemo(() => {
    const uv = def.params.find((p) => /undervoltage/.test(p.key))?.key;
    const soft = def.params.filter((p) => /soft_enable$/.test(p.key)).map((p) => p.key);
    return { uv, soft, all: [...(uv ? [uv] : []), ...soft] };
  }, [def]);
  const vals = useParamValues(view.uid48, keys.all);
  const out: Warning[] = [];
  const uv = keys.uv ? vals[keys.uv] : undefined;
  if (vSig && Number.isFinite(volts) && uv !== undefined && volts < uv + 1)
    out.push({ key: 'battery', icon: BatteryLow, params: { v: fmtValue(volts, 'V', 1), min: fmtValue(uv, 'V', 1) } });
  if (view.flags.unsaved) out.push({ key: 'unsaved', icon: Save });
  if (view.faults.active !== 0) out.push({ key: 'fault', icon: TriangleAlert });
  if (api.integrating && keys.soft.length > 0 && keys.soft.every((k) => vals[k] === 0)) out.push({ key: 'softLimit', icon: ShieldOff });
  return out;
}

function ArmCard() {
  const api = useTuner();
  const busy = useTunerUi((s) => s.busy);
  const warnings = useWarnings();
  const manual = api.config.signal.kind === 'manual';
  const startDisabled = !api.armed || !!busy || manual || api.signalBlock !== null;
  const startHint = !api.armed ? tTuner('needArm') : manual ? tTuner('test.manualHint') : api.signalBlock ? tTuner(`block.${api.signalBlock}`) : tTuner('test.startHint');
  return (
    <div className="tuner-arm">
      <div className="tuner-arm__row">
        <ArmButton session={api.session} block disabled={api.problem !== null} />
        <Tooltip content={startHint} block>
          <Button variant="primary" icon={Play} disabled={startDisabled} onClick={() => void api.runClosed()} block>
            {tTuner('test.start')}
          </Button>
        </Tooltip>
      </div>
      <ul className="tuner-checks" aria-label={tTuner('warn.title')}>
        {warnings.length === 0 ? (
          <li className="is-ok">
            <CircleCheck size={13} aria-hidden /> {tTuner('warn.ready')}
          </li>
        ) : (
          warnings.map((w) => (
            <li key={w.key} className="is-warn">
              <w.icon size={13} aria-hidden /> {tTuner(`warn.${w.key}`, w.params)}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
