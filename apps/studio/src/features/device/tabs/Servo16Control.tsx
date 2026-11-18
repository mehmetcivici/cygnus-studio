import { memo, useEffect, useMemo, useState } from 'react';
import { Crosshair, Gamepad2, PowerOff } from 'lucide-react';
import { SERVO16_CHANNELS, type ModelDef } from '@cygnus/protocol';
import { useI18n } from '../../../i18n';
import { Button, Checkbox, Panel, Slider, cx } from '../../../ui';
import { ArmButton, DriveBanner, useDriveSession, useParam, useSignal, type DeviceView } from '../../../core';
import { framePulses } from '../logic/servo';
import { tDevice } from '../messages';

const OWNER = 'device';
const CENTER = 1500;

interface Channel {
  on: boolean;
  us: number;
}

const ChannelRow = memo(function ChannelRow({ uid48, ch, value, onChange }: { uid48: string; ch: number; value: Channel; onChange: (ch: number, v: Channel) => void }) {
  const { fmtNumber } = useI18n();
  const out = useSignal(uid48, `ch.${ch}.pulse`);
  const min = useParam(uid48, `ch.${ch}.min_us`).value ?? 1000;
  const max = useParam(uid48, `ch.${ch}.max_us`).value ?? 2000;
  const center = useParam(uid48, `ch.${ch}.center_us`).value ?? CENTER;
  const enabled = useParam(uid48, `ch.${ch}.enable`).value;
  return (
    <div className={cx('dv-srow', !value.on && 'is-off')}>
      <Checkbox checked={value.on} onChange={(on) => onChange(ch, { on, us: on && !value.on ? center : value.us })} label={<span className="cy-mono">{tDevice('viz.pdh.ch', { n: ch })}</span>} disabled={enabled === 0} />
      <Slider value={value.us} min={min} max={max} step={5} onChange={(us) => onChange(ch, { ...value, us })} disabled={!value.on} showValue={false} ariaLabel={tDevice('viz.pdh.ch', { n: ch })} />
      <span className="dv-srow__value cy-mono">{value.on ? `${fmtNumber(value.us, 0)}` : '—'}</span>
      <span className="dv-srow__out cy-mono" title={tDevice('control.servo.out')}>
        {enabled === 0 ? tDevice('viz.servo.disabled') : Number.isFinite(out) && out > 0 ? `${fmtNumber(out, 0)} µs` : tDevice('viz.servo.off')}
      </span>
    </div>
  );
});

/** 16-channel servo board: one slider per channel, each channel switched on explicitly. */
export function Servo16Control({ device, def }: { device: DeviceView; def: ModelDef }) {
  const { session, armed, busyOwner } = useDriveSession(OWNER, device.uid48);
  const [chs, setChs] = useState<Channel[]>(() => Array.from({ length: SERVO16_CHANNELS }, () => ({ on: false, us: CENTER })));
  const frames = useMemo(() => def.controls.filter((c) => c.format === 'servo4'), [def]);

  useEffect(() => {
    const dev = session?.device;
    if (!armed || !dev) return;
    // Re-sent on every change: the frames join the session's periodic repeat.
    for (const f of frames) dev.control.send(f.key, { pulsesUs: framePulses(chs, f.firstChannel ?? 1) }, { repeat: true });
  }, [armed, session, chs, frames]);

  const update = (ch: number, v: Channel): void => setChs((cur) => cur.map((c, i) => (i === ch - 1 ? v : c)));
  const half = SERVO16_CHANNELS / 2;
  return (
    <div className="dv-control">
      <DriveBanner session={session} />
      <Panel
        title={tDevice('control.servo.title')}
        icon={Gamepad2}
        actions={
          <>
            <Button size="sm" variant="secondary" icon={Crosshair} onClick={() => setChs((cur) => cur.map((c) => ({ ...c, us: CENTER })))}>
              {tDevice('control.servo.center')}
            </Button>
            <Button size="sm" variant="ghost" icon={PowerOff} onClick={() => setChs((cur) => cur.map((c) => ({ ...c, on: false })))}>
              {tDevice('control.servo.allOff')}
            </Button>
          </>
        }
      >
        <div className="dv-servo-grid">
          {[0, 1].map((col) => (
            <div key={col} className="dv-servo-col">
              {chs.slice(col * half, (col + 1) * half).map((c, i) => (
                <ChannelRow key={col * half + i} uid48={device.uid48} ch={col * half + i + 1} value={c} onChange={update} />
              ))}
            </div>
          ))}
        </div>
        <div className="dv-control__arm">
          <ArmButton session={session} size="lg" disabled={!device.online} />
          <p className="dv-note">{busyOwner ? tDevice('control.busy', { owner: busyOwner }) : tDevice('control.servo.help')}</p>
        </div>
      </Panel>
    </div>
  );
}
