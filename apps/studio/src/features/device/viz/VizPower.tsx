import { memo } from 'react';
import { ArrowRight, Zap } from 'lucide-react';
import { signalByKey, type ModelDef } from '@cygnus/protocol';
import { useI18n } from '../../../i18n';
import { Badge, BarMeter, Gauge, Sparkline, cx } from '../../../ui';
import { useParam, useSignal, useSignals, useTrend } from '../../../core';
import { tDevice } from '../messages';
import { CenterBar, FuseChips, Readout, VizBlock, useSignalFormat, type VizProps } from './shared';

const PDH_CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8];
const PDH_KEYS = ['input.voltage', 'total.current', 'fuse.mask', 'aux5.voltage', 'aux5.current', 'aux12.voltage', 'aux12.current', 'power', 'energy', 'temp'] as const;

const ChannelBar = memo(function ChannelBar({ uid48, ch, max, blown }: { uid48: string; ch: number; max: number; blown: boolean }) {
  const v = useSignal(uid48, `ch.${ch}.current`);
  const warn = useParam(uid48, `ch.${ch}.warn_a`).value;
  return (
    <div className={cx('dv-chan', blown && 'is-blown')}>
      <BarMeter
        value={Number.isFinite(v) ? v : null}
        max={max}
        threshold={warn}
        unit="A"
        height={150}
        width={26}
        tone={blown ? 'danger' : undefined}
        label={<span className="cy-mono">{tDevice('viz.pdh.ch', { n: ch })}</span>}
      />
      <span className={cx('dv-chan__fuse', blown && 'is-blown')}>{blown ? tDevice('viz.fuseBlown') : tDevice('viz.fuseOk')}</span>
    </div>
  );
});

function AuxRail({ uid48, def, rail, volts, amps }: { uid48: string; def: ModelDef; rail: '5' | '12'; volts: number; amps: number }) {
  const { t } = useI18n();
  const fmt = useSignalFormat(def);
  const enabled = useParam(uid48, rail === '5' ? 'aux.5v_enable' : 'aux.12v_enable').value;
  const v = fmt(`aux${rail}.voltage`, volts);
  return (
    <div className={cx('dv-aux', enabled === 0 && 'is-off')}>
      <div className="dv-aux__head">
        <span className="dv-aux__name">{tDevice('viz.pdh.aux', { v: rail })}</span>
        <Badge size="sm" tone={enabled === 0 ? 'neutral' : 'ok'}>
          {enabled === undefined ? '—' : enabled ? t('common.on') : t('common.off')}
        </Badge>
      </div>
      <CenterBar value={amps} min={0} max={1.5} label={`${v.text} ${v.unit}`} text={fmt(`aux${rail}.current`, amps).text} unit="A" tone={amps > 1 ? 'danger' : amps > 0.8 ? 'warn' : 'accent'} />
    </div>
  );
}

/** Large power distribution: channel current bars with warn lines, fuses, aux rails, energy. */
export function VizPdhLarge({ uid48, def }: VizProps) {
  const s = useSignals(uid48, PDH_KEYS);
  const fmt = useSignalFormat(def);
  const totalWarn = useParam(uid48, 'power.total_warn_a').value;
  const uvWarn = useParam(uid48, 'power.uv_warn_v').value;
  const mask = s['fuse.mask'] ?? NaN;
  const chMax = signalByKey(def, 'ch.1.current')?.range[1] ?? 40;
  const totalMax = signalByKey(def, 'total.current')?.range[1] ?? 200;
  const vin = s['input.voltage'] ?? NaN;
  const total = s['total.current'] ?? NaN;
  const blownCount = Number.isFinite(mask) ? PDH_CHANNELS.filter((c) => (mask & (1 << (c - 1))) !== 0).length : 0;
  return (
    <div className="dv-viz dv-viz--wide">
      <VizBlock
        title={tDevice('viz.pdh.channels')}
        aside={
          blownCount > 0 ? (
            <Badge tone="danger" size="sm" variant="solid">
              {tDevice('viz.pdh.blownCount', { count: blownCount })}
            </Badge>
          ) : (
            <span className="dv-block__meta">{tDevice('viz.pdh.thresholdHint')}</span>
          )
        }
      >
        <div className="dv-chans">
          {PDH_CHANNELS.map((ch) => (
            <ChannelBar key={ch} uid48={uid48} ch={ch} max={chMax} blown={Number.isFinite(mask) && (mask & (1 << (ch - 1))) !== 0} />
          ))}
        </div>
      </VizBlock>
      <VizBlock title={tDevice('viz.pdh.supply')}>
        <div className="dv-readouts dv-readouts--grid">
          <Readout label={fmt('input.voltage', vin).label} text={fmt('input.voltage', vin).text} unit="V" size="lg" tone={uvWarn !== undefined && vin < uvWarn ? 'warn' : undefined} />
          <Readout label={fmt('power', NaN).label} text={fmt('power', s.power ?? NaN).text} unit="W" size="lg" />
        </div>
        <CenterBar value={total} min={0} max={totalMax} label={fmt('total.current', total).label} text={fmt('total.current', total).text} unit="A" tone={totalWarn !== undefined && total > totalWarn ? 'danger' : 'accent'} />
        <div className="dv-readouts">
          <Readout label={fmt('energy', NaN).label} text={fmt('energy', s.energy ?? NaN).text} unit="Wh" size="sm" />
          <Readout label={fmt('temp', NaN).label} text={fmt('temp', s.temp ?? NaN).text} unit={fmt('temp', s.temp ?? NaN).unit} size="sm" />
        </div>
        <div className="dv-auxes">
          <AuxRail uid48={uid48} def={def} rail="5" volts={s['aux5.voltage'] ?? NaN} amps={s['aux5.current'] ?? NaN} />
          <AuxRail uid48={uid48} def={def} rail="12" volts={s['aux12.voltage'] ?? NaN} amps={s['aux12.current'] ?? NaN} />
        </div>
      </VizBlock>
    </div>
  );
}

const SMALL_KEYS = ['input.voltage', 'total.current', 'rail5.voltage', 'rail12.voltage', 'fuse.mask'] as const;

/** Small power distribution: rails and four fuses. */
export function VizPdhSmall({ uid48, def }: VizProps) {
  const s = useSignals(uid48, SMALL_KEYS);
  const fmt = useSignalFormat(def);
  const uvWarn = useParam(uid48, 'power.uv_warn_v').value;
  const bits = signalByKey(def, 'fuse.mask')?.bits ?? [];
  const { tl } = useI18n();
  const vin = s['input.voltage'] ?? NaN;
  return (
    <div className="dv-viz">
      <VizBlock title={tDevice('viz.pdh.supply')}>
        <div className="dv-readouts dv-readouts--grid">
          <Readout label={fmt('input.voltage', vin).label} text={fmt('input.voltage', vin).text} unit="V" size="lg" tone={uvWarn !== undefined && vin < uvWarn ? 'warn' : undefined} />
          <Readout label={fmt('total.current', NaN).label} text={fmt('total.current', s['total.current'] ?? NaN).text} unit="A" size="lg" />
          <Readout label={fmt('rail5.voltage', NaN).label} text={fmt('rail5.voltage', s['rail5.voltage'] ?? NaN).text} unit="V" />
          <Readout label={fmt('rail12.voltage', NaN).label} text={fmt('rail12.voltage', s['rail12.voltage'] ?? NaN).text} unit="V" />
        </div>
      </VizBlock>
      <VizBlock title={tDevice('viz.pdh.fuses')}>
        <FuseChips mask={s['fuse.mask'] ?? NaN} count={bits.length || 4} labels={(i) => (bits[i] ? tl(bits[i]) : String(i + 1))} />
      </VizBlock>
    </div>
  );
}

const SOC_KEYS = ['input.voltage', 'output.voltage', 'output.current', 'output.ripple', 'temp', 'brownout.count'] as const;

/** SoC regulator: input → output flow, load, ripple with trend, brownouts. */
export function VizSoc({ uid48, def }: VizProps) {
  const s = useSignals(uid48, SOC_KEYS);
  const fmt = useSignalFormat(def);
  const nominal = useParam(uid48, 'reg.output_v').value;
  const warnA = useParam(uid48, 'reg.current_warn_a').value;
  const ripple = useTrend(uid48, 'output.ripple');
  const vin = s['input.voltage'] ?? NaN;
  const vout = s['output.voltage'] ?? NaN;
  const iout = s['output.current'] ?? NaN;
  const rip = s['output.ripple'] ?? NaN;
  const ioutMax = signalByKey(def, 'output.current')?.range[1] ?? 6;
  const deviation = nominal !== undefined && Number.isFinite(vout) ? Math.abs(vout - nominal) / nominal : 0;
  const brown = s['brownout.count'] ?? NaN;
  return (
    <div className="dv-viz">
      <VizBlock title={tDevice('viz.soc.flow')}>
        <div className="dv-flow">
          <Readout label={fmt('input.voltage', NaN).label} text={fmt('input.voltage', vin).text} unit="V" size="lg" />
          <span className="dv-flow__arrow">
            <Zap size={16} aria-hidden />
            <ArrowRight size={20} aria-hidden />
          </span>
          <Readout label={fmt('output.voltage', NaN).label} text={fmt('output.voltage', vout).text} unit="V" size="lg" tone={deviation > 0.05 ? 'warn' : 'ok'} />
        </div>
        {nominal !== undefined && <p className="dv-note">{tDevice('viz.soc.nominal', { v: nominal })}</p>}
        <div className="dv-gauges">
          <Gauge
            value={Number.isFinite(iout) ? iout : null}
            min={0}
            max={ioutMax}
            unit="A"
            digits={2}
            label={fmt('output.current', NaN).label}
            zones={warnA !== undefined ? [{ from: warnA, to: ioutMax, tone: 'caution' }] : undefined}
            size={150}
          />
        </div>
      </VizBlock>
      <VizBlock title={tDevice('viz.soc.quality')}>
        <Readout label={fmt('output.ripple', NaN).label} text={fmt('output.ripple', rip).text} unit="mV" tone={rip > 100 ? 'warn' : undefined} />
        <div className="dv-spark">
          <Sparkline values={ripple} height={56} fill />
        </div>
        <div className="dv-readouts">
          <Readout label={fmt('brownout.count', NaN).label} text={fmt('brownout.count', brown).text} size="sm" tone={brown > 0 ? 'warn' : undefined} />
          <Readout label={fmt('temp', NaN).label} text={fmt('temp', s.temp ?? NaN).text} unit={fmt('temp', NaN).unit} size="sm" />
        </div>
      </VizBlock>
    </div>
  );
}
