import { signalByKey } from '@cygnus/protocol';
import { useI18n } from '../../../i18n';
import { Badge, Gauge, type GaugeZone } from '../../../ui';
import { toDisplayUnit, useParam, useSettings, useSignals } from '../../../core';
import { tDevice } from '../messages';
import { CenterBar, Readout, VizBlock, useSignalFormat, type VizProps } from './shared';

const KEYS = ['velocity', 'bus.current', 'phase.current', 'duty', 'temp.fet', 'temp.motor', 'bus.voltage', 'loop.output', 'ctrl.mode', 'position', 'energy'] as const;

function num(v: number | undefined): number {
  return v ?? NaN;
}

/** ESC: speed / current / temperature gauges, duty bar, control mode. */
export function VizEsc({ uid48, def }: VizProps) {
  const { tl } = useI18n();
  const s = useSignals(uid48, KEYS);
  const fmt = useSignalFormat(def);
  const tempUnit = useSettings((x) => x.tempUnit);
  const tempLimit = useParam(uid48, 'limits.temp_c').value;
  const supplyLimit = useParam(uid48, 'limits.supply_current_a').value;
  const range = (k: string): [number, number] => signalByKey(def, k)?.range ?? [0, 1];
  const [vMin, vMax] = range('velocity');
  const vel = num(s.velocity);
  const cur = num(s['bus.current']);
  const fet = toDisplayUnit(num(s['temp.fet']), '°C', { tempUnit, angleUnit: 'rot' });
  const fetMax = toDisplayUnit(120, '°C', { tempUnit, angleUnit: 'rot' }).value;
  const limitDisp = tempLimit !== undefined ? toDisplayUnit(tempLimit, '°C', { tempUnit, angleUnit: 'rot' }).value : fetMax * 0.83;
  const tempZones: GaugeZone[] = [
    { from: limitDisp - (fetMax - limitDisp), to: limitDisp, tone: 'caution' },
    { from: limitDisp, to: fetMax, tone: 'danger' },
  ];
  const [, cMax] = range('bus.current');
  const curZones: GaugeZone[] | undefined = supplyLimit ? [{ from: supplyLimit, to: Math.max(cMax, supplyLimit), tone: 'danger' }] : undefined;
  const modeSig = signalByKey(def, 'ctrl.mode');
  const mode = modeSig?.options?.find((o) => o.value === s['ctrl.mode']);
  const duty = num(s.duty);
  const out = num(s['loop.output']);
  const [oMin, oMax] = range('loop.output');
  const [pMin, pMax] = range('phase.current');
  const phase = num(s['phase.current']);
  return (
    <div className="dv-viz dv-viz--wide">
      <VizBlock
        title={tDevice('viz.esc.drive')}
        aside={
          <Badge tone={mode && mode.value !== 0 ? 'accent' : 'neutral'} size="sm">
            {tDevice('viz.esc.mode')}: {mode ? tl(mode.label) : '—'}
          </Badge>
        }
      >
        <div className="dv-gauges">
          <Gauge value={Number.isFinite(vel) ? Math.abs(vel) : null} min={0} max={Math.max(Math.abs(vMin), vMax)} unit="rpm" digits={0} label={vel < 0 ? tDevice('viz.esc.speedRev') : tDevice('viz.esc.speed')} size={168} />
          <Gauge value={Number.isFinite(cur) ? cur : null} min={0} max={cMax} unit="A" digits={1} label={fmt('bus.current', cur).label} zones={curZones} size={168} />
          <Gauge value={Number.isFinite(fet.value) ? fet.value : null} min={0} max={fetMax} unit={fet.unit} digits={0} label={fmt('temp.fet', NaN).label} zones={tempZones} size={168} />
        </div>
      </VizBlock>
      <VizBlock title={tDevice('viz.esc.output')}>
        <div className="dv-bars">
          <CenterBar value={duty} min={-1} max={1} label={fmt('duty', duty).label} text={Number.isFinite(duty) ? `${(duty * 100).toFixed(0)}` : '—'} unit="%" tone={Math.abs(duty) > 0.9 ? 'caution' : 'accent'} />
          <CenterBar value={out} min={oMin} max={oMax} label={fmt('loop.output', out).label} text={fmt('loop.output', out).text} unit="V" />
          <CenterBar value={phase} min={pMin} max={pMax} label={fmt('phase.current', phase).label} text={fmt('phase.current', phase).text} unit="A" />
        </div>
        <div className="dv-readouts">
          {(['bus.voltage', 'position', 'temp.motor', 'energy'] as const).map((k) => {
            const f = fmt(k, num(s[k]));
            return <Readout key={k} label={f.label} text={f.text} unit={f.unit} size="sm" />;
          })}
        </div>
      </VizBlock>
    </div>
  );
}
