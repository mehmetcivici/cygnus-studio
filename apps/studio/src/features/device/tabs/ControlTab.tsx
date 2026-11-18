import { useEffect, useMemo, useRef, useState } from 'react';
import { Gamepad2, Minus, Plus, SlidersHorizontal, Square } from 'lucide-react';
import { signalByKey, type ControlFrameDef, type ControlLoop, type ModelDef } from '@cygnus/protocol';
import { useI18n } from '../../../i18n';
import { Button, EmptyState, LiveChart, NumberField, Panel, SegmentedControl, SeriesBuffer, Slider } from '../../../ui';
import { ArmButton, useDriveSession, type DeviceView } from '../../../core';
import { navigate } from '../../../app/nav';
import { controlRange, driveModes } from '../logic/control';
import { tDevice } from '../messages';
import { Servo16Control } from './Servo16Control';

export const DRIVE_OWNER = 'device';

/** Manual drive panel: actuators only, always through a drive session and the arm button. */
export function ControlTab({ device }: { device: DeviceView }) {
  const def = device.def;
  if (!def) return null;
  const set = def.controls.find((c) => c.format === 'set');
  if (def.controls.some((c) => c.format === 'servo4')) return <Servo16Control device={device} def={def} />;
  if (!set) return <EmptyState icon={Gamepad2} title={tDevice('control.none')} description={tDevice('control.noneBody')} />;
  return <SetDrive device={device} def={def} frame={set} />;
}

function SetDrive({ device, def, frame }: { device: DeviceView; def: ModelDef; frame: ControlFrameDef }) {
  const { tl, fmtNumber } = useI18n();
  const { session, armed, armGeneration, busyOwner } = useDriveSession(DRIVE_OWNER, device.uid48);
  const modes = useMemo(() => driveModes(frame), [frame]);
  const [modeKey, setModeKey] = useState(() => (modes.find((m) => m.key === 'velocity') ?? modes.find((m) => m.key === 'position') ?? modes[0])?.key ?? '');
  const mode = modes.find((m) => m.key === modeKey) ?? modes[0];
  const range = useMemo(() => (mode ? controlRange(def, mode) : null), [def, mode]);
  const [target, setTarget] = useState(0);
  const targetRef = useRef(0);
  targetRef.current = target;
  const loop = useRef<ControlLoop | null>(null);
  const measuredKey = mode?.measured;
  const clampT = (v: number): number => (range ? Math.min(range.max, Math.max(range.min, v)) : 0);
  // "No motion": zero speed/duty/current, or hold where it is in position mode.
  const neutralTarget = (): number => {
    const here = mode?.key === 'position' && measuredKey ? device.handle.getSignal(measuredKey) : 0;
    return clampT(Number.isFinite(here) ? here : 0);
  };
  const neutralRef = useRef(neutralTarget);
  neutralRef.current = neutralTarget;

  // Every stop resets the target and every arm starts from it: re-enabling never resumes the
  // previous command (review: blur → re-arm drove straight back to 3000 rpm).
  useEffect(
    () =>
      session?.onDisarm(() => {
        loop.current = null;
        setTarget(neutralRef.current());
      }),
    [session],
  );
  useEffect(() => {
    if (!armed || !session?.device || !mode) return;
    const start = neutralRef.current();
    targetRef.current = start;
    setTarget(start);
    const l = session.device.control.start(mode.key, start);
    loop.current = l;
    // The host ends the session on BOOT/E-STOP/fault/renumbering: disarm, never restart it.
    const off = l.onStopped((reason) => {
      if (loop.current !== l) return;
      loop.current = null;
      setTarget(neutralRef.current());
      if (reason !== 'stopped') session.disarm('deviceFault');
    });
    return () => {
      off();
      if (loop.current === l) loop.current = null;
      l.stop();
    };
    // Mode changes retarget the running loop below instead of restarting it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, session, armGeneration]);
  useEffect(() => {
    loop.current?.update(target);
  }, [target]);
  useEffect(() => {
    // A new mode starts from its own "no motion" target: a velocity target is no sane position
    // target, and position 0 would move the mechanism.
    const start = neutralRef.current();
    setTarget(start);
    if (mode) loop.current?.setMode(mode.key, start);
  }, [mode]);

  // Target vs measured for the mini chart, fed at STATUS rate outside React.
  const setpointKey = signalByKey(def, 'setpoint') ? 'setpoint' : null;
  const bufs = useMemo(() => ({ target: new SeriesBuffer(6000), measured: new SeriesBuffer(6000) }), [modeKey]);
  useEffect(() => {
    const h = device.handle;
    return h.onSignals((u) => {
      const t = u.t / 1000;
      const m = measuredKey ? u.values[measuredKey] : NaN;
      if (measuredKey && u.keys.includes(measuredKey) && m !== undefined) bufs.measured.push(t, m);
      if (setpointKey && u.keys.includes(setpointKey)) {
        const sp = u.values[setpointKey];
        if (sp !== undefined) bufs.target.push(t, sp);
      } else if (!setpointKey && measuredKey && u.keys.includes(measuredKey)) bufs.target.push(t, armed ? targetRef.current : NaN);
    });
  }, [device.handle, measuredKey, setpointKey, bufs, armed]);

  if (!mode) return <EmptyState icon={Gamepad2} title={tDevice('control.none')} />;
  const hasTarget = mode.min !== mode.max;
  const step = range ? range.step * 5 : 0;
  const measuredDef = measuredKey ? signalByKey(def, measuredKey) : undefined;
  const stopHere = (): void => setTarget(neutralTarget());
  const loops = def.tuner.loops;
  return (
    <div className="dv-control">
      <div className="dv-control__grid">
        <Panel
          title={tDevice('control.title')}
          icon={Gamepad2}
          actions={
            loops.length > 0 ? (
              <Button size="sm" variant="ghost" icon={SlidersHorizontal} onClick={() => navigate('tuner', { device: device.uid48 })}>
                {tDevice('control.toTuner')}
              </Button>
            ) : undefined
          }
        >
          <div className="dv-control__body">
            <div className="dv-control__row">
              <span className="dv-field-label">{tDevice('control.mode')}</span>
              <SegmentedControl<string> value={mode.key} onChange={setModeKey} size="sm" options={modes.map((m) => ({ value: m.key, label: tl(m.label) }))} ariaLabel={tDevice('control.mode')} />
            </div>
            {hasTarget && range ? (
              <>
                <div className="dv-control__row">
                  <span className="dv-field-label">{tDevice('control.target')}</span>
                  <NumberField value={target} disabled={!armed} onCommit={(v) => setTarget(clampT(v))} min={mode.min} max={mode.max} step={range.step} digits={range.digits} unit={mode.unit} size="sm" width={150} ariaLabel={tDevice('control.target')} commitOnStep />
                  <span className="dv-dim">
                    {fmtNumber(range.min, range.digits)} … {fmtNumber(range.max, range.digits)} {mode.unit}
                  </span>
                </div>
                <Slider value={target} disabled={!armed} onChange={(v) => setTarget(clampT(v))} min={range.min} max={range.max} step={range.step} bipolar={range.min < 0} digits={range.digits} unit={mode.unit} ariaLabel={tDevice('control.target')} />
                <div className="dv-control__quick">
                  <Button size="sm" variant="secondary" icon={Minus} disabled={!armed} onClick={() => setTarget(clampT(target - step))}>
                    {fmtNumber(step, range.digits)}
                  </Button>
                  <Button size="sm" variant="secondary" icon={Square} disabled={!armed} onClick={stopHere}>
                    {tDevice('control.stop')}
                  </Button>
                  <Button size="sm" variant="secondary" icon={Plus} disabled={!armed} onClick={() => setTarget(clampT(target + step))}>
                    {fmtNumber(step, range.digits)}
                  </Button>
                </div>
              </>
            ) : (
              <p className="dv-note">{tDevice('control.noTarget')}</p>
            )}
            <div className="dv-control__arm">
              <ArmButton session={session} size="lg" disabled={!device.online} />
            </div>
            <p className="dv-note">{busyOwner ? tDevice('control.busy', { owner: busyOwner }) : tDevice(armed ? 'control.safety' : 'control.armFirst')}</p>
          </div>
        </Panel>
        <Panel title={tDevice('control.chart')} padding="sm" className="dv-control__chart">
          <LiveChart
            window={10}
            height={300}
            legend="bottom"
            toolbar={false}
            series={[
              { key: 'target', label: tDevice('control.chartTarget'), buffer: bufs.target, unit: mode.unit, dash: [6, 4], color: 'chart-2', digits: range?.digits ?? 2 },
              { key: 'measured', label: measuredDef ? tl(measuredDef.label) : tDevice('control.chartMeasured'), buffer: bufs.measured, unit: measuredDef?.unit ?? mode.unit, color: 'accent', digits: measuredDef?.digits ?? 2 },
            ]}
          />
        </Panel>
      </div>
    </div>
  );
}
