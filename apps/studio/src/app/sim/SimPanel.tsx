import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import {
  Cable,
  ChevronDown,
  ChevronRight,
  Factory,
  Hand,
  Plus,
  Power,
  PowerOff,
  RotateCw,
  Trash2,
  Unplug,
  Wand2,
  X,
} from 'lucide-react';
import { getModel } from '@cygnus/protocol';
import type { InjectionKind, NodeSnapshot, SimSnapshot, Simulation } from '@cygnus/simulator';
import { useI18n } from '../../i18n';
import {
  Badge,
  Button,
  IconButton,
  NumberField,
  SegmentedControl,
  Select,
  Slider,
  StatusDot,
  Toggle,
  toast,
  cx,
  type DeviceStatus,
} from '../../ui';
import { LEGACY_MODEL_NAME, connection, setAmbientWanted, useConnection, useSimulation } from '../../core';
import { ModelIcon } from '../../core/components';
import { scenarioInfo } from '../connect';
import { tShell } from '../messages';
import { ADDABLE_MODELS, addBoard } from './addBoard';
import './sim.css';

export const useSimPanel = create<{ open: boolean }>(() => ({ open: false }));
export const toggleSimPanel = (): void => useSimPanel.setState((s) => ({ open: !s.open }));

const SPEEDS = [0.25, 0.5, 1, 2] as const;

/** Top bar button; only present while a scenario runs. */
export function SimToggle() {
  const sim = useSimulation();
  const open = useSimPanel((s) => s.open);
  if (!sim) return null;
  return (
    <Button size="sm" variant={open ? 'primary' : 'secondary'} icon={Wand2} onClick={toggleSimPanel} aria-pressed={open}>
      {tShell('sim.button')}
    </Button>
  );
}

function useSnapshot(sim: Simulation | null, hz = 5): SimSnapshot | null {
  const [snap, setSnap] = useState<SimSnapshot | null>(null);
  useEffect(() => {
    if (!sim) {
      setSnap(null);
      return;
    }
    const read = (): void => setSnap(sim.snapshot());
    read();
    const h = setInterval(read, 1000 / hz);
    return () => clearInterval(h);
  }, [sim, hz]);
  return snap;
}

function nodeStatus(n: NodeSnapshot): DeviceStatus {
  if (!n.powered || n.mode === 'off') return 'offline';
  if (n.mode === 'boot' || n.mode === 'bootloader') return 'boot';
  if (n.faults.active) return 'fault';
  if (!n.connected || n.conflict || n.num === 63 || n.faults.warn || n.faults.sticky) return 'warn';
  return 'ok';
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="cy-simp__section">
      <header className="cy-simp__sechead">
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

function injectionArg(kind: InjectionKind): number {
  return kind === 'fuseBlown' || kind === 'selfTestFail' ? 1 : 0;
}

function NodeRow({ sim, n }: { sim: Simulation; n: NodeSnapshot }) {
  const { tl } = useI18n();
  const [open, setOpen] = useState(false);
  const def = getModel(n.model);
  const name = n.name || (def ? tl(def.name) : n.modelKey === 'cyncoder_v3' ? tl(LEGACY_MODEL_NAME) : n.modelKey);
  const act = (fn: () => void) => () => {
    try {
      fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const available = n.injections.filter((k) => !n.activeInjections.includes(k));
  return (
    <li className={cx('cy-simnode', open && 'is-open', !n.powered && 'is-off')}>
      <div className="cy-simnode__row">
        <button type="button" className="cy-simnode__main" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          <StatusDot status={nodeStatus(n)} size={7} />
          <ModelIcon def={def} size={14} />
          <span className="cy-simnode__name">{name}</span>
          <span className="cy-simnode__num cy-mono">#{n.num === 63 ? '—' : n.num}</span>
          {!n.connected && <Badge size="sm" tone="warn">{tShell('sim.unplugged')}</Badge>}
          {n.activeInjections.length > 0 && (
            <Badge size="sm" tone="danger">
              {n.activeInjections.length}
            </Badge>
          )}
        </button>
        <IconButton
          size="sm"
          icon={n.connected ? Cable : Unplug}
          active={!n.connected}
          label={n.connected ? tShell('sim.cablePull') : tShell('sim.cablePlug')}
          onClick={act(() => sim.setCable(n.id, !n.connected))}
        />
        <IconButton
          size="sm"
          icon={n.powered ? Power : PowerOff}
          active={!n.powered}
          label={n.powered ? tShell('sim.powerOff') : tShell('sim.powerOn')}
          onClick={act(() => sim.setPower(n.id, !n.powered))}
        />
      </div>
      {open && (
        <div className="cy-simnode__detail">
          <div className="cy-simnode__meta cy-mono">
            {n.modelKey} · {n.uid48Hex} · fw {n.fw.major}.{n.fw.minor}.{n.fw.patch} · {tShell(`sim.mode.${n.mode}`)} · {n.supplyV.toFixed(1)} V
          </div>
          <div className="cy-simnode__actions">
            <Button size="sm" icon={RotateCw} onClick={act(() => sim.powerCycle(n.id))}>
              {tShell('sim.powerCycle')}
            </Button>
            <Button
              size="sm"
              icon={Factory}
              onClick={act(() => {
                sim.factoryReset(n.id);
                toast.info(tShell('sim.factoryResetDone', { name }));
              })}
            >
              {tShell('sim.factoryReset')}
            </Button>
            <IconButton size="sm" icon={Trash2} label={tShell('sim.remove')} onClick={act(() => sim.removeNode(n.id))} />
          </div>
          <div className="cy-simnode__inject">
            <Select<InjectionKind>
              size="sm"
              value={null}
              placeholder={tShell('sim.injectPick')}
              options={available.map((k) => ({ value: k, label: tShell(`sim.injection.${k}`) }))}
              onChange={(k) => act(() => sim.inject(n.id, k, true, injectionArg(k)))()}
              disabled={available.length === 0}
              width="100%"
              ariaLabel={tShell('sim.inject')}
            />
          </div>
          {n.activeInjections.length > 0 && (
            <div className="cy-simnode__active">
              {n.activeInjections.map((k) => (
                <button type="button" key={k} className="cy-simchip" onClick={act(() => sim.inject(n.id, k, false, injectionArg(k)))}>
                  {tShell(`sim.injection.${k}`)}
                  <X size={12} aria-hidden />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Mechanics({ sim, snap }: { sim: Simulation; snap: SimSnapshot }) {
  const { fmtNumber } = useI18n();
  const [shaftId, setShaftId] = useState<string | null>(null);
  const [rpm, setRpm] = useState(600);
  const [load, setLoad] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [roll, setRoll] = useState(0);
  const shafts = snap.shafts;
  const shaft = shafts.find((s) => s.id === shaftId) ?? shafts[0];
  // Sync the load slider when another shaft is selected, not on every snapshot.
  useEffect(() => {
    if (shaft) setLoad(shaft.loadNm);
  }, [shaft?.id]);
  const w = sim.world;
  return (
    <>
      {shafts.length === 0 ? (
        <p className="cy-simp__muted">{tShell('sim.noShafts')}</p>
      ) : (
        shaft && (
          <div className="cy-simmech">
            <div className="cy-simmech__head">
              <Select<string>
                size="sm"
                value={shaft.id}
                options={shafts.map((s) => ({ value: s.id, label: s.label || s.id }))}
                onChange={setShaftId}
                width="100%"
                ariaLabel={tShell('sim.shaft')}
              />
              <span className="cy-simmech__rpm cy-mono">{fmtNumber(shaft.rpm, 0)} rpm</span>
              {shaft.hand && <Badge size="sm" tone="accent" icon={Hand}>{tShell('sim.hand')}</Badge>}
              {shaft.jammed && <Badge size="sm" tone="danger">{tShell('sim.jammed')}</Badge>}
            </div>
            <div className="cy-simmech__row">
              <NumberField value={rpm} onCommit={setRpm} unit="rpm" min={-6000} max={6000} step={100} size="sm" width={130} ariaLabel={tShell('sim.rpm')} />
              <Button size="sm" icon={Hand} onClick={() => w.handTurn(shaft.id, rpm, sim.timeMs, -1)}>
                {tShell('sim.turn')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => w.handRelease(shaft.id)} disabled={!shaft.hand}>
                {tShell('sim.release')}
              </Button>
            </div>
            <div className="cy-simmech__row">
              <Button size="sm" onClick={() => w.handRotate(shaft.id, 0.25, sim.timeMs, 300)}>
                {tShell('sim.quarter')}
              </Button>
              <Button size="sm" onClick={() => w.push(shaft.id, 0.8, sim.timeMs, 250)}>
                {tShell('sim.push')} +
              </Button>
              <Button size="sm" onClick={() => w.push(shaft.id, -0.8, sim.timeMs, 250)}>
                {tShell('sim.push')} −
              </Button>
              <Toggle size="sm" checked={shaft.jammed} onChange={(c) => w.setJammed(shaft.id, c)} label={tShell('sim.jam')} />
            </div>
            <label className="cy-simp__field">
              <span>{tShell('sim.load')}</span>
              <Slider value={load} onChange={setLoad} onCommit={(v) => w.setLoad(shaft.id, v)} min={-2} max={2} step={0.05} bipolar showValue unit="N·m" digits={2} />
            </label>
          </div>
        )
      )}
      <div className="cy-simmech">
        <div className="cy-simmech__head">
          <strong>{tShell('sim.body')}</strong>
          <span className="cy-simmech__rpm cy-mono">
            yaw {fmtNumber(snap.body.yawDeg, 0)}° · {fmtNumber(snap.body.yawRateDps, 0)}°/s
          </span>
        </div>
        <label className="cy-simp__field">
          <span>{tShell('sim.pitch')}</span>
          <Slider value={pitch} onChange={setPitch} onCommit={(v) => w.tiltBody(v, roll)} min={-45} max={45} step={1} bipolar showValue unit="°" digits={0} />
        </label>
        <label className="cy-simp__field">
          <span>{tShell('sim.roll')}</span>
          <Slider value={roll} onChange={setRoll} onCommit={(v) => w.tiltBody(pitch, v)} min={-45} max={45} step={1} bipolar showValue unit="°" digits={0} />
        </label>
        <div className="cy-simmech__row">
          <Button size="sm" onClick={() => w.spinBody(-45, sim.timeMs, 1500)}>
            ⟲ {tShell('sim.spin')}
          </Button>
          <Button size="sm" onClick={() => w.spinBody(45, sim.timeMs, 1500)}>
            {tShell('sim.spin')} ⟳
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setPitch(0);
              setRoll(0);
              w.tiltBody(0, 0);
            }}
          >
            {tShell('sim.level')}
          </Button>
        </div>
      </div>
    </>
  );
}

function AddBoard({ sim }: { sim: Simulation }) {
  const { tl } = useI18n();
  const [model, setModel] = useState<number>(ADDABLE_MODELS[0] ?? 1);
  const options = useMemo(() => ADDABLE_MODELS.map((m) => ({ value: m, label: tl(getModel(m)?.name) })), [tl]);
  return (
    <div className="cy-simadd">
      <Select<number> size="sm" value={model} options={options} onChange={setModel} width="100%" ariaLabel={tShell('sim.addModel')} />
      <Button
        size="sm"
        variant="primary"
        icon={Plus}
        onClick={() => {
          addBoard(sim, model);
          toast.success(tShell('sim.added', { name: tl(getModel(model)?.name) }));
        }}
      >
        {tShell('sim.add')}
      </Button>
      <p className="cy-simp__muted">{tShell('sim.addHint')}</p>
    </div>
  );
}

/** Right-hand drawer: the "wizard's curtain" for demos. */
export function SimDrawer() {
  const { t, tl, fmtNumber } = useI18n();
  const open = useSimPanel((s) => s.open);
  const sim = useSimulation();
  const speed = useConnection((s) => s.simSpeed);
  const ambient = useConnection((s) => s.ambient);
  const source = useConnection((s) => s.source);
  const snap = useSnapshot(open ? sim : null);
  const [loss, setLoss] = useState(0);
  const [battery, setBattery] = useState(12.8);
  useEffect(() => {
    if (!sim) return;
    setLoss(Math.round(sim.bus.lossRate * 100));
    setBattery(Math.round(sim.world.battery.nominalV * 10) / 10);
  }, [sim]);
  useEffect(() => {
    if (!sim) useSimPanel.setState({ open: false });
  }, [sim]);
  if (!open || !sim || !snap) return null;
  const info = scenarioInfo(source?.kind === 'sim' ? source.scenarioId : null);
  return (
    <aside className="cy-simp" aria-label={tShell('sim.title')}>
      <header className="cy-simp__head">
        <div className="cy-simp__titles">
          <h2>
            <Wand2 size={16} aria-hidden /> {tShell('sim.title')}
          </h2>
          <p>{info ? tl(info.name) : ''} · {tShell('sim.time')} <span className="cy-mono">{fmtNumber(snap.timeMs / 1000, 1)} s</span></p>
        </div>
        <IconButton icon={X} label={t('common.close')} onClick={() => useSimPanel.setState({ open: false })} noTooltip />
      </header>
      <div className="cy-simp__body">
        <p className="cy-simp__muted">{tShell('sim.subtitle')}</p>
        <div className="cy-simp__speed">
          <span>{tShell('sim.speed')}</span>
          <SegmentedControl<number>
            size="sm"
            value={speed}
            onChange={(v) => connection.setSimSpeed(v)}
            options={SPEEDS.map((s) => ({ value: s, label: `${String(s).replace('.', ',')}×` }))}
            ariaLabel={tShell('sim.speed')}
          />
        </div>
        <Toggle checked={ambient} onChange={(c) => setAmbientWanted(c)} label={tShell('sim.ambient')} size="sm" />

        <Section title={tShell('sim.bus')}>
          <label className="cy-simp__field">
            <span>{tShell('sim.loss')}</span>
            <Slider value={loss} onChange={setLoss} onCommit={(v) => sim.setBusLoss(v)} min={0} max={50} step={1} showValue unit="%" digits={0} />
          </label>
          <label className="cy-simp__field">
            <span>{tShell('sim.battery')}</span>
            <Slider value={battery} onChange={setBattery} onCommit={(v) => sim.setBatteryVoltage(v)} min={6} max={16.8} step={0.1} showValue unit="V" digits={1} />
          </label>
          <div className="cy-simp__toggles">
            <Toggle size="sm" checked={snap.bus.shorted} onChange={(c) => sim.setBusShort(c)} label={tShell('sim.short')} tone="danger" />
            <Toggle size="sm" checked={snap.battery.connected} onChange={(c) => sim.setBatteryConnected(c)} label={tShell('sim.batteryConnected')} />
          </div>
          <div className="cy-simp__stats cy-mono">
            {fmtNumber(snap.battery.voltage, 2)} V · {fmtNumber(snap.battery.current, 1)} A · %{fmtNumber(snap.bus.load * 100, 0)} · {fmtNumber(snap.bus.framesPerSec, 0)} fr/s · R×{snap.bus.terminations}
          </div>
        </Section>

        <Section title={`${tShell('sim.boards')} (${snap.nodes.length})`}>
          <ul className="cy-simnodes">
            {snap.nodes.map((n) => (
              <NodeRow key={n.id} sim={sim} n={n} />
            ))}
          </ul>
        </Section>

        <Section title={tShell('sim.add')}>
          <AddBoard sim={sim} />
        </Section>

        <Section title={tShell('sim.mech')}>
          <Mechanics sim={sim} snap={snap} />
        </Section>
      </div>
    </aside>
  );
}
