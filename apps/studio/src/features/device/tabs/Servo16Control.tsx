import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Gamepad2, PowerOff } from 'lucide-react';
import { SERVO16_CHANNELS, type ModelDef } from '@cygnus/protocol';
import { useI18n } from '../../../i18n';
import { Button, Checkbox, Panel, Slider, cx } from '../../../ui';
import { ArmButton, useDriveSession, useParam, useSignal, type DeviceView } from '../../../core';
import { framePulses } from '../logic/servo';
import { tDevice } from '../messages';

const OWNER = 'device';
const CENTER = 1500;

interface Channel {
  on: boolean;
  us: number;
}

const ChannelRow = memo(function ChannelRow({ uid48, ch, value, onChange, locked }: { uid48: string; ch: number; value: Channel; onChange: (ch: number, v: Channel) => void; locked: boolean }) {
  const { fmtNumber } = useI18n();
  const out = useSignal(uid48, `ch.${ch}.pulse`);
  const min = useParam(uid48, `ch.${ch}.min_us`).value ?? 1000;
  const max = useParam(uid48, `ch.${ch}.max_us`).value ?? 2000;
  const center = useParam(uid48, `ch.${ch}.center_us`).value ?? CENTER;
  const enabled = useParam(uid48, `ch.${ch}.enable`).value;
  return (
    <div className={cx('dv-srow', !value.on && 'is-off')}>
      <Checkbox checked={value.on} onChange={(on) => onChange(ch, { on, us: on && !value.on ? center : value.us })} label={<span className="cy-mono">{tDevice('viz.pdh.ch', { n: ch })}</span>} disabled={locked || enabled === 0} />
      <Slider value={value.us} min={min} max={max} step={5} onChange={(us) => onChange(ch, { ...value, us })} disabled={locked || !value.on} showValue={false} ariaLabel={tDevice('viz.pdh.ch', { n: ch })} />
      <span className="dv-srow__value cy-mono">{value.on ? `${fmtNumber(value.us, 0)}` : '—'}</span>
      <span className="dv-srow__out cy-mono" title={tDevice('control.servo.out')}>
        {enabled === 0 ? tDevice('viz.servo.disabled') : Number.isFinite(out) && out > 0 ? `${fmtNumber(out, 0)} µs` : tDevice('viz.servo.off')}
      </span>
    </div>
  );
});

function allOff(): Channel[] {
  return Array.from({ length: SERVO16_CHANNELS }, () => ({ on: false, us: CENTER }));
}

/** 16-channel servo board: one slider per channel, each channel switched on explicitly. */
export function Servo16Control({ device, def }: { device: DeviceView; def: ModelDef }) {
  const { session, armed, armGeneration, busyOwner } = useDriveSession(OWNER, device.uid48);
  const [chs, setChs] = useState<Channel[]>(allOff);
  const frames = useMemo(() => def.controls.filter((c) => c.format === 'servo4'), [def]);
  const sentGen = useRef(0);

  // Every stop switches every channel off and every arm starts from there: re-enabling never
  // brings back the last pulses (an ESC on a channel would get its last throttle).
  useEffect(() => session?.onDisarm(() => setChs(allOff())), [session]);
  useEffect(() => setChs(allOff()), [armGeneration]);

  useEffect(() => {
    const dev = session?.device;
    if (!armed || !dev) return;
    // The host ended the session on its own (BOOT, E-STOP, fault, renumbering): a new `send`
    // would start a fresh one. Disarm instead.
    if (sentGen.current === armGeneration && !dev.control.active) {
      session.disarm('deviceFault');
      return;
    }
    // Re-sent on every change: the frames join the session's periodic repeat.
    for (const f of frames) dev.control.send(f.key, { pulsesUs: framePulses(chs, f.firstChannel ?? 1) }, { repeat: true });
    sentGen.current = armGeneration;
  }, [armed, session, chs, frames, armGeneration]);

  const update = (ch: number, v: Channel): void => setChs((cur) => cur.map((c, i) => (i === ch - 1 ? v : c)));
  const half = SERVO16_CHANNELS / 2;
  return (
    <div className="dv-control">
      <Panel
        title={tDevice('control.servo.title')}
        icon={Gamepad2}
        actions={
          <>
            <Button size="sm" variant="secondary" icon={Crosshair} disabled={!armed} onClick={() => setChs((cur) => cur.map((c) => ({ ...c, us: CENTER })))}>
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
                <ChannelRow key={col * half + i} uid48={device.uid48} ch={col * half + i + 1} value={c} onChange={update} locked={!armed} />
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
