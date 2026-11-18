import { Info } from 'lucide-react';
import { MagnetStatus, V3Health, signalByKey } from '@cygnus/protocol';
import { useI18n } from '../../../i18n';
import { Badge, type Tone } from '../../../ui';
import { useParam, useSignals } from '../../../core';
import { tDevice } from '../messages';
import { CenterBar, Dial, Readout, VizBlock, useSignalFormat, type VizProps } from './shared';

const KEYS = ['abs.position', 'position', 'velocity', 'magnet.agc', 'magnet.status', 'raw.angle', 'temp'] as const;
const LEGACY_KEYS = ['abs.position', 'position', 'velocity', 'magnet.agc', 'magnet.health', 'magnet.field', 'protocol.version'] as const;

const MAGNET_TONE: Record<number, Tone> = { [MagnetStatus.OK]: 'ok', [MagnetStatus.WEAK]: 'warn', [MagnetStatus.STRONG]: 'warn', [MagnetStatus.MISSING]: 'danger' };
const LEGACY_TONE: Record<number, Tone> = { [V3Health.GOOD]: 'ok', [V3Health.FAR]: 'warn', [V3Health.ERROR]: 'danger', [V3Health.SENSOR_FAULT]: 'danger' };

/** Absolute angle in degrees 0..360 from a turn fraction (either 0..1 or ±0.5 range). */
export function absDegrees(rot: number): number {
  if (!Number.isFinite(rot)) return NaN;
  const f = rot - Math.floor(rot);
  return f * 360;
}

function AngleDial({ abs, multi, fmtTurns }: { abs: number; multi: number; fmtTurns: string }) {
  const { fmtNumber } = useI18n();
  const deg = absDegrees(abs);
  const turns = Number.isFinite(multi) ? Math.trunc(multi) : NaN;
  return (
    <Dial
      angle={deg}
      center={
        <>
          <span className="cy-mono">{fmtNumber(deg, 1)}</span>
          <span className="dv-readout__unit">°</span>
        </>
      }
      sub={
        <>
          <span className="dv-dial__turns cy-mono">{Number.isFinite(turns) ? (turns > 0 ? `+${turns}` : String(turns)) : '—'}</span> {tDevice('viz.enc.turns')}
          <div className="dv-dial__multi cy-mono">{fmtTurns}</div>
        </>
      }
      ariaLabel={tDevice('viz.enc.absolute')}
    />
  );
}

/** CyCAN Cyncoder: absolute angle dial, multi-turn counter, magnet health. */
export function VizEncoder({ uid48, def }: VizProps) {
  const { tl } = useI18n();
  const s = useSignals(uid48, KEYS);
  const fmt = useSignalFormat(def);
  const weak = useParam(uid48, 'mag.agc_weak').value;
  const strong = useParam(uid48, 'mag.agc_strong').value;
  const status = s['magnet.status'] ?? NaN;
  const opt = signalByKey(def, 'magnet.status')?.options?.find((o) => o.value === status);
  const agc = s['magnet.agc'] ?? NaN;
  const pos = fmt('position', s.position ?? NaN);
  const agcTone: Tone = !Number.isFinite(agc) ? 'neutral' : (weak !== undefined && agc >= weak) || (strong !== undefined && agc <= strong) ? 'warn' : 'ok';
  return (
    <div className="dv-viz dv-viz--encoder">
      <VizBlock title={tDevice('viz.enc.angle')}>
        <AngleDial abs={s['abs.position'] ?? NaN} multi={s.position ?? NaN} fmtTurns={`${pos.text} ${pos.unit}`} />
      </VizBlock>
      <VizBlock
        title={tDevice('viz.enc.magnet')}
        aside={
          <Badge tone={MAGNET_TONE[status] ?? 'neutral'} size="sm">
            {opt ? tl(opt.label) : '—'}
          </Badge>
        }
      >
        <CenterBar value={agc} min={0} max={255} label={fmt('magnet.agc', agc).label} text={fmt('magnet.agc', agc).text} tone={agcTone} />
        <p className="dv-note">{tDevice('viz.enc.agcHelp')}</p>
        <div className="dv-readouts">
          {(['velocity', 'raw.angle', 'temp'] as const).map((k) => {
            const f = fmt(k, s[k] ?? NaN);
            return <Readout key={k} label={f.label} text={f.text} unit={f.unit} size="sm" />;
          })}
        </div>
      </VizBlock>
    </div>
  );
}

/** Cyncoder 1.4 on the legacy FRC protocol: same dial, magnet health, limited features note. */
export function VizLegacyEncoder({ uid48, def }: VizProps) {
  const { tl } = useI18n();
  const s = useSignals(uid48, LEGACY_KEYS);
  const fmt = useSignalFormat(def);
  const health = s['magnet.health'] ?? NaN;
  const opt = signalByKey(def, 'magnet.health')?.options?.find((o) => o.value === health);
  const pos = fmt('position', s.position ?? NaN);
  const agc = s['magnet.agc'] ?? NaN;
  return (
    <div className="dv-viz dv-viz--encoder">
      <div className="dv-strip dv-strip--info">
        <Info size={15} aria-hidden />
        <span>
          <strong>{tDevice('viz.legacy.title')}</strong> {tDevice('viz.legacy.body')}
        </span>
      </div>
      <VizBlock title={tDevice('viz.enc.angle')}>
        <AngleDial abs={s['abs.position'] ?? NaN} multi={s.position ?? NaN} fmtTurns={`${pos.text} ${pos.unit}`} />
      </VizBlock>
      <VizBlock
        title={tDevice('viz.enc.magnetHealth')}
        aside={
          <Badge tone={LEGACY_TONE[health] ?? 'neutral'} size="sm">
            {opt ? tl(opt.label) : '—'}
          </Badge>
        }
      >
        <CenterBar value={agc} min={0} max={255} label={fmt('magnet.agc', agc).label} text={fmt('magnet.agc', agc).text} />
        <div className="dv-readouts">
          {(['velocity', 'magnet.field', 'protocol.version'] as const).map((k) => {
            const f = fmt(k, s[k] ?? NaN);
            return <Readout key={k} label={f.label} text={f.text} unit={f.unit} size="sm" />;
          })}
        </div>
      </VizBlock>
    </div>
  );
}
