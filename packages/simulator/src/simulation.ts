import { NUM_UNASSIGNED, type Text } from '@cygnus/protocol';
import { SimBus, type BusStats } from './bus';
import { NodeMode, type InjectionKind, type NodeSnapshot, type SimContext, type SimNode } from './node';
import { Prng } from './prng';
import { SimTransport } from './transport';
import { SUBSTEPS, World, type BodySnapshot, type PowerFeed, type ShaftSnapshot } from './world';

export interface SimulationOptions {
  seed?: number;
  /** Bus and host adapter carry CAN-FD (default true). */
  fd?: boolean;
  /** Fixed termination resistors on the bus besides switchable ones on boards (default 2). */
  baseTerminations?: number;
  label?: Text;
  /** Scenario this simulation is built from; scenario boards derive their UIDs from it. */
  scenarioId?: string;
}

/** A board that supplies other boards (PDH, regulator). */
export interface PowerDistributor {
  /** Feeds this board supplies (their `load` is summed afresh every step). */
  readonly feeds: readonly PowerFeed[];
  /** Sets the voltages of the feeds it owns from its own supply. Called after the battery update. */
  distribute(dtS: number): void;
}

function isDistributor(n: object): n is PowerDistributor {
  return typeof (n as Partial<PowerDistributor>).distribute === 'function';
}

export interface SimSnapshot {
  timeMs: number;
  bus: BusStats & { queued: number };
  battery: { voltage: number; current: number; ocv: number; usedAh: number; connected: boolean };
  nodes: NodeSnapshot[];
  shafts: ShaftSnapshot[];
  body: BodySnapshot;
}

export type SimEvent = { kind: 'nodeAdded' | 'nodeRemoved'; id: string } | { kind: 'reset' };

/**
 * The simulated machine: virtual bus + boards + mechanical world, advanced in 1 ms steps.
 * Deterministic: the same seed and the same calls give the same frames.
 */
export class Simulation implements SimContext {
  timeMs = 0;
  readonly seed: number;
  readonly rng: Prng;
  readonly bus: SimBus;
  readonly world: World;
  label: Text;
  /** Scenario this simulation was built from, if any. */
  scenarioId = '';
  /** Vehicle scenarios: template slot id → where it lives in the simulation. */
  readonly slotPlacements: Record<string, { nodeId: string; channel?: number; shaftId?: string }> = {};
  /** Added to frame timestamps given to the host (RealtimeRunner aligns it with the wall clock). */
  hostTimeOffset = 0;
  private readonly nodeList: SimNode[] = [];
  private powerOrder: SimNode[] = [];
  private readonly manualOff = new Set<SimNode>();
  private readonly listeners = new Set<(e: SimEvent) => void>();
  private fraction = 0;
  private baseTerminations: number;
  private nodeSalt = 0;

  constructor(o: SimulationOptions = {}) {
    this.seed = o.seed ?? 1;
    this.scenarioId = o.scenarioId ?? '';
    this.rng = new Prng(this.seed);
    this.bus = new SimBus(this.rng.fork(0xb05), { fd: o.fd ?? true });
    this.world = new World(this.rng.fork(0x3011d));
    this.baseTerminations = o.baseTerminations ?? 2;
    this.label = o.label ?? { tr: 'Simülatör', en: 'Simulator' };
  }

  // ---- topology --------------------------------------------------------------------------

  /** Adds a board (also while running: it powers up and boots on the next step). */
  addNode<T extends SimNode>(node: T, o: { connected?: boolean } = {}): T {
    if (this.nodeList.some((n) => n.id === node.id)) throw new Error(`duplicate node id ${node.id}`);
    node.attach(this, this.rng.fork(++this.nodeSalt * 0x9e37));
    if (!node.feed) node.feed = this.world.battery.feed;
    this.nodeList.push(node);
    this.bus.attach(node, o.connected ?? true);
    this.reorderPower();
    this.emit({ kind: 'nodeAdded', id: node.id });
    return node;
  }

  removeNode(id: string): void {
    const n = this.node(id);
    n.powerOff();
    this.bus.detach(n);
    this.nodeList.splice(this.nodeList.indexOf(n), 1);
    this.manualOff.delete(n);
    // Boards fed by the removed one lose power.
    for (const other of this.nodeList) if (other.feed?.owner === n) other.feed = null;
    this.reorderPower();
    this.emit({ kind: 'nodeRemoved', id });
  }

  get nodes(): readonly SimNode[] {
    return this.nodeList;
  }

  node(id: string): SimNode {
    const n = this.nodeList.find((x) => x.id === id);
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  findNode(id: string): SimNode | undefined {
    return this.nodeList.find((x) => x.id === id);
  }

  /** Moves a board to another supply feed (e.g. a PDH channel). */
  setFeed(id: string, feed: PowerFeed | null): void {
    this.node(id).feed = feed;
    this.reorderPower();
  }

  private reorderPower(): void {
    const depth = (n: SimNode, guard: number): number => {
      const owner = n.feed?.owner;
      return owner && guard < 8 && this.nodeList.includes(owner as SimNode) ? 1 + depth(owner as SimNode, guard + 1) : 0;
    };
    this.powerOrder = [...this.nodeList].sort((a, b) => depth(b, 0) - depth(a, 0));
  }

  onEvent(cb: (e: SimEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: SimEvent): void {
    for (const cb of this.listeners) cb(e);
  }

  // ---- time ------------------------------------------------------------------------------

  /** Advances simulated time by `ms` (fractions carry over to the next call). */
  advance(ms: number): void {
    this.fraction += Math.max(0, ms);
    let steps = Math.floor(this.fraction);
    this.fraction -= steps;
    while (steps-- > 0) this.step();
  }

  /** Host-clock time of a simulation timestamp. */
  hostTime(simMs: number): number {
    return simMs + this.hostTimeOffset;
  }

  private step(): void {
    const t = this.timeMs;
    this.bus.step(t, 1);
    this.powerStep();
    const w = this.world;
    for (let s = 0; s < SUBSTEPS; s++) w.substep(s);
    this.timeMs = t + 1;
    w.finishStep(this.timeMs);
    const ns = this.nodeList;
    for (let i = 0; i < ns.length; i++) ns[i]!.tick();
    if (this.timeMs % 50 === 0) this.updateTerminations();
  }

  private powerStep(): void {
    const w = this.world;
    const bat = w.battery;
    bat.feed.load = 0;
    const order = this.powerOrder;
    // Every feed starts the step at zero, including distributor outputs nothing on the bus
    // is attached to (PWM ESCs on a PDH channel): loads must not pile up across steps.
    for (let i = 0; i < order.length; i++) {
      const n = order[i]!;
      if (n.feed) n.feed.load = 0;
      if (isDistributor(n)) for (const f of n.feeds) f.load = 0;
    }
    for (let i = 0; i < w.pwmEscs.length; i++) {
      const e = w.pwmEscs[i]!;
      if (e.feed) e.feed.load = 0;
    }
    for (let i = 0; i < w.pwmEscs.length; i++) {
      const e = w.pwmEscs[i]!;
      if (e.feed) e.feed.load += e.supplyCurrent;
    }
    // Deepest boards first, so a distributor's own draw includes everything below it.
    for (let i = 0; i < order.length; i++) {
      const n = order[i]!;
      if (n.feed && !this.manualOff.has(n)) n.feed.load += n.supplyCurrent();
    }
    bat.update(bat.feed.load, 0.001);
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i]!;
      const v = n.feed && !this.manualOff.has(n) ? n.feed.voltage : 0;
      n.setSupply(v);
      if (isDistributor(n)) n.distribute(0.001);
    }
  }

  private updateTerminations(): void {
    let t = this.baseTerminations;
    for (const n of this.nodeList) if (n.terminationOn && this.bus.isConnected(n)) t++;
    this.bus.terminations = t;
  }

  // ---- host ------------------------------------------------------------------------------

  /** A Transport that connects a host client to this bus. */
  createTransport(label?: string): SimTransport {
    return new SimTransport(this, label ?? `${this.label.tr}`);
  }

  // ---- control panel API -----------------------------------------------------------------

  /** Pulls or plugs a board's CAN cable (it stays powered). */
  setCable(id: string, connected: boolean): void {
    this.bus.setConnected(this.node(id), connected);
  }

  /** Switches a board's power (unplug its supply). Power returning reboots it. */
  setPower(id: string, on: boolean): void {
    const n = this.node(id);
    if (on) this.manualOff.delete(n);
    else {
      this.manualOff.add(n);
      n.powerOff();
    }
  }

  powerCycle(id: string): void {
    this.setPower(id, false);
    this.setPower(id, true);
  }

  inject(id: string, kind: InjectionKind, on = true, arg = 0): boolean {
    return this.node(id).inject(kind, on, arg);
  }

  setBatteryVoltage(v: number): void {
    this.world.battery.nominalV = v;
    this.world.battery.usedAh = 0;
  }

  setBatteryConnected(on: boolean): void {
    this.world.battery.connected = on;
  }

  /** Percentage (0..100) of frames destroyed on the wire. */
  setBusLoss(percent: number): void {
    this.bus.lossRate = Math.max(0, Math.min(100, percent)) / 100;
  }

  /** Shorts CAN_H/CAN_L: nothing gets through, boards flag CAN errors. */
  setBusShort(on: boolean): void {
    this.bus.shorted = on;
  }

  setBaseTerminations(n: number): void {
    this.baseTerminations = n;
    this.updateTerminations();
  }

  /** Puts every board back to factory state (number 63, defaults) — for the discovery demo. */
  factoryReset(id: string): void {
    const n = this.node(id);
    n.factoryReset();
  }

  snapshot(): SimSnapshot {
    const b = this.world.battery;
    return {
      timeMs: this.timeMs,
      bus: { ...this.bus.stats, queued: this.bus.queued },
      battery: { voltage: b.feed.voltage, current: b.current, ocv: b.ocv, usedAh: b.usedAh, connected: b.connected },
      nodes: this.nodeList.map((n) => n.snapshot(this.bus.isConnected(n))),
      shafts: this.world.snapshotShafts(),
      body: this.world.snapshotBody(),
    };
  }

  /** Number of boards still unassigned (63) or in conflict. */
  countUnresolved(): number {
    return this.nodeList.filter((n) => n.mode !== NodeMode.OFF && (n.num === NUM_UNASSIGNED || n.conflict)).length;
  }
}
