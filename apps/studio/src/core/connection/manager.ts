/// <reference types="w3c-web-serial" />
import { create } from 'zustand';
import {
  CygnusBus,
  CyncoderV3Driver,
  GyroCalStatus,
  RoboRioBridgeTransport,
  SlcanTransport,
  realScheduler,
  type Transport,
  type TransportState,
} from '@cygnus/protocol';
import { RealtimeRunner, createScenario, scenarios, type Simulation } from '@cygnus/simulator';
import { readStoredJson, writeStored } from '../../lib/storage';
import { confirmLeave } from '../safety/busy';
import { createSlcanOverWebSerial, describeSerialPort, isWebSerialSupported, requestSerialPort } from '../transports/webserial';
import { isTauri, openSerialStream, openTcpStream } from '../transports/tauri';
import {
  DEFAULT_SERIAL_BAUD,
  DEMO_SCENARIO_ID,
  ROBORIO_PORT,
  SIM_SEED,
  isStoredSource,
  toStored,
  type ConnectionSource,
  type StoredSource,
} from './sources';

/**
 * `lost`: the link dropped while connected (cable pulled, adapter gone); the bus and its device
 * handles are kept (offline) until the user reconnects or disconnects.
 */
export type ConnectionPhase = 'idle' | 'connecting' | 'connected' | 'lost' | 'error';

export interface ConnectionState {
  phase: ConnectionPhase;
  /** Last requested source (also while connecting / after an error). */
  source: StoredSource | null;
  /** Short human label: scenario name key or port description. */
  label: string;
  error: string | null;
  transportKind: string | null;
  /** The link carries CAN-FD. */
  fd: boolean;
  /** Simulation behind the bus, when the source is a scenario. */
  sim: Simulation | null;
  runner: RealtimeRunner | null;
  /** Simulated ms per wall-clock ms. */
  simSpeed: number;
  /** Gentle "hand of god" motion that keeps the demo scenario alive. */
  ambient: boolean;
  /** Increments on every new bus, so effects can key on it. */
  generation: number;
  bus: CygnusBus | null;
}

const STORAGE_KEY = 'cy.connection.last';

export const useConnection = create<ConnectionState>(() => ({
  phase: 'idle',
  source: null,
  label: '',
  error: null,
  transportKind: null,
  fd: false,
  sim: null,
  runner: null,
  simSpeed: 1,
  ambient: false,
  generation: 0,
  bus: null,
}));

type BusListener = (bus: CygnusBus | null) => void;
/** Runs before a bus is closed on purpose (disconnect / source change), while it can still send. */
type TeardownListener = (bus: CygnusBus) => void;

export interface ConnectOptions {
  /** Skip the busy-lock confirmation (internal restarts, tests). */
  force?: boolean;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Owns the one active CygnusBus. Services bind to it through `onBusChange` (store, safety,
 * recorder); screens use the hooks. Only one connect runs at a time; a newer request wins.
 */
class ConnectionManager {
  private bus: CygnusBus | null = null;
  private lastSource: ConnectionSource | null = null;
  private readonly listeners = new Set<BusListener>();
  private readonly teardownListeners = new Set<TeardownListener>();
  private unsubs: Array<() => void> = [];
  private token = 0;
  private stopAmbient: (() => void) | null = null;

  get current(): CygnusBus | null {
    return this.bus;
  }

  /** Called immediately with the current bus, then on every change (null = none). */
  onBusChange(cb: BusListener): () => void {
    this.listeners.add(cb);
    cb(this.bus);
    return () => this.listeners.delete(cb);
  }

  /**
   * Called synchronously before an intentional teardown while the link is still up (phase
   * `connected`), e.g. to send neutral commands. Not called when the link was lost.
   */
  onBeforeTeardown(cb: TeardownListener): () => void {
    this.teardownListeners.add(cb);
    return () => this.teardownListeners.delete(cb);
  }

  private setBus(bus: CygnusBus | null): void {
    this.bus = bus;
    useConnection.setState({ bus });
    for (const cb of this.listeners) {
      try {
        cb(bus);
      } catch (e) {
        console.error('[connection] bus listener failed', e);
      }
    }
  }

  /** Starts a simulator scenario; `assigned: false` brings boards up factory-fresh (number 63). */
  connectScenario(scenarioId: string, opts: { assigned?: boolean; seed?: number } & ConnectOptions = {}): Promise<boolean> {
    const { force, ...sim } = opts;
    return this.connect({ kind: 'sim', scenarioId, ...sim }, { force });
  }

  async connect(source: ConnectionSource, opts: ConnectOptions = {}): Promise<boolean> {
    if (!opts.force && this.bus && !(await confirmLeave('disconnect'))) return false;
    if (source.kind === 'webserial' && !source.port && isWebSerialSupported()) {
      // Ask for the port first (inside the click): cancelling the chooser keeps the current bus.
      try {
        source = { kind: 'webserial', port: await requestSerialPort() };
      } catch {
        return false;
      }
    }
    const token = ++this.token;
    await this.teardown();
    if (token !== this.token) return false;
    const stored = toStored(source);
    useConnection.setState({ phase: 'connecting', source: stored, error: null, label: labelOf(source) });
    let sim: Simulation | null = null;
    let runner: RealtimeRunner | null = null;
    try {
      let transport: Transport;
      let label = labelOf(source);
      if (source.kind === 'sim') {
        sim = createScenario(source.scenarioId, { seed: source.seed ?? SIM_SEED, ...(source.assigned === false ? { assigned: false } : {}) });
        transport = sim.createTransport();
        runner = new RealtimeRunner(sim, realScheduler, { tickMs: 4, speed: useConnection.getState().simSpeed });
        runner.start();
      } else if (source.kind === 'webserial') {
        if (!isWebSerialSupported()) throw new Error('webserial-unsupported');
        const port = source.port;
        if (!port) throw new Error('webserial-unsupported');
        const r = await createSlcanOverWebSerial(port);
        transport = r.transport;
        label = describeSerialPort(port);
        // Keep the granted port so "reconnect" does not need the chooser again.
        source = { kind: 'webserial', port, label };
      } else if (source.kind === 'tauri-serial') {
        if (!isTauri()) throw new Error('tauri-unavailable');
        const stream = await openSerialStream(source.path, source.baud ?? DEFAULT_SERIAL_BAUD);
        transport = new SlcanTransport(stream, { scheduler: realScheduler, label: source.label ?? source.path });
      } else {
        if (!isTauri()) throw new Error('tauri-unavailable');
        const port = source.port ?? ROBORIO_PORT;
        const stream = await openTcpStream(source.host, port);
        transport = new RoboRioBridgeTransport(stream, { scheduler: realScheduler, label: `roboRIO ${source.host}` });
      }
      if (token !== this.token) {
        runner?.stop();
        await transport.close().catch(() => undefined);
        return false;
      }
      const bus = new CygnusBus(transport, realScheduler, { drivers: [new CyncoderV3Driver()] });
      this.lastSource = source;
      this.unsubs.push(bus.on('transportState', (s) => this.onTransportState(bus, s)));
      this.setBus(bus);
      useConnection.setState((st) => ({
        sim,
        runner,
        transportKind: transport.info.kind,
        fd: transport.info.fd,
        label,
        source: toStored(source),
        generation: st.generation + 1,
      }));
      await bus.start();
      if (token !== this.token) return false;
      useConnection.setState({ phase: 'connected', error: null });
      writeStored(STORAGE_KEY, JSON.stringify(toStored(source)));
      if (sim && source.kind === 'sim' && source.scenarioId === DEMO_SCENARIO_ID) this.setAmbient(true);
      return true;
    } catch (e) {
      runner?.stop();
      if (token !== this.token) return false;
      await this.teardown();
      useConnection.setState({ phase: 'error', error: errText(e), sim: null, runner: null });
      return false;
    }
  }

  private onTransportState(bus: CygnusBus, s: TransportState): void {
    if (bus !== this.bus) return;
    const phase = useConnection.getState().phase;
    if ((s.phase === 'error' || s.phase === 'closed') && phase === 'connected') {
      useConnection.setState({ phase: 'lost', error: s.error ?? null });
    }
  }

  /** Reopens the last source (granted serial ports reopen without a prompt). */
  reconnect(opts: ConnectOptions = {}): Promise<boolean> {
    const src = this.lastSource ?? fromStored(useConnection.getState().source);
    if (!src) return Promise.resolve(false);
    return this.connect(src, opts);
  }

  /** Closes the link. Returns false when the user kept it (busy lock confirmation declined). */
  async disconnect(opts: ConnectOptions = {}): Promise<boolean> {
    if (!opts.force && this.bus && !(await confirmLeave('disconnect'))) return false;
    ++this.token;
    await this.teardown();
    useConnection.setState({ phase: 'idle', error: null });
    return true;
  }

  private async teardown(): Promise<void> {
    this.setAmbient(false);
    const bus = this.bus;
    if (bus && useConnection.getState().phase === 'connected') {
      for (const cb of this.teardownListeners) {
        try {
          cb(bus);
        } catch (e) {
          console.error('[connection] teardown listener failed', e);
        }
      }
    }
    const { runner } = useConnection.getState();
    for (const u of this.unsubs.splice(0)) u();
    if (bus) {
      this.setBus(null);
      try {
        await bus.stop();
      } catch (e) {
        console.warn('[connection] bus stop failed', e);
      }
      try {
        await bus.transport.close();
      } catch {
        // Already closed or the port is gone.
      }
    }
    runner?.stop();
    useConnection.setState({ sim: null, runner: null, transportKind: null, fd: false });
  }

  setSimSpeed(speed: number): void {
    const { runner } = useConnection.getState();
    if (runner) runner.speed = speed;
    useConnection.setState({ simSpeed: speed });
  }

  /** Turns the demo motion on/off: a flywheel spun by hand and a slowly yawing chassis. */
  setAmbient(on: boolean): void {
    this.stopAmbient?.();
    this.stopAmbient = null;
    const { sim } = useConnection.getState();
    if (on && sim) this.stopAmbient = startAmbient(sim);
    useConnection.setState({ ambient: on && !!sim });
  }

  /** First launch and the demo build start a scenario; a remembered scenario restarts too. */
  autoStart(): void {
    const demo = import.meta.env.MODE === 'demo';
    const last = readStoredJson(STORAGE_KEY, isStoredSource);
    if (demo || !last) {
      void this.connect({ kind: 'sim', scenarioId: DEMO_SCENARIO_ID });
      return;
    }
    if (last.kind === 'sim' && scenarios.some((s) => s.id === last.scenarioId)) {
      void this.connect({ kind: 'sim', scenarioId: last.scenarioId });
      return;
    }
    // Hardware is never opened without a click; the welcome screen offers it.
    useConnection.setState({ source: last, label: last.kind === 'sim' ? last.scenarioId : storedLabel(last) });
  }
}

function startAmbient(sim: Simulation): () => void {
  const shaft = sim.world.shafts.find((s) => s.id === 'flywheel') ?? sim.world.shafts[0];
  if (shaft) sim.world.handTurn(shaft.id, 1200, sim.timeMs, -1);
  let alive = true;
  let dir = 1;
  // Turning the chassis while a gyro calibrates would (correctly) fault it: wait those out.
  const calibrating = (): boolean => sim.snapshot().nodes.some((n) => n.signals['cal.status'] === GyroCalStatus.RUNNING || (n.modelKey === 'gyro' && n.mode === 'boot'));
  const spin = (): void => {
    if (!alive) return;
    if (!calibrating()) {
      sim.world.spinBody(18 * dir, sim.timeMs, 2500);
      dir = -dir;
    }
    timer = setTimeout(spin, 5000);
  };
  let timer = setTimeout(spin, 6000);
  return () => {
    alive = false;
    clearTimeout(timer);
    if (shaft) sim.world.handRelease(shaft.id);
  };
}

function fromStored(s: StoredSource | null): ConnectionSource | null {
  if (!s) return null;
  if (s.kind === 'webserial') return { kind: 'webserial' };
  return s;
}

function storedLabel(s: StoredSource): string {
  switch (s.kind) {
    case 'sim':
      return s.scenarioId;
    case 'webserial':
      return s.label ?? 'Web Serial';
    case 'tauri-serial':
      return s.label ?? s.path;
    case 'roborio':
      return `roboRIO ${s.host}`;
  }
}

function labelOf(s: ConnectionSource): string {
  if (s.kind === 'webserial' && s.port) return describeSerialPort(s.port);
  return storedLabel(toStored(s));
}

export const connection = new ConnectionManager();

/** The active bus (null while disconnected). Re-renders when the bus instance changes. */
export function useBus(): CygnusBus | null {
  return useConnection((s) => s.bus);
}

/** The simulation behind the bus, or null when connected to hardware / not connected. */
export function useSimulation(): Simulation | null {
  return useConnection((s) => s.sim);
}
