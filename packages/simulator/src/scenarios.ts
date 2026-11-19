import { CYNCODER_V3_DEF, DevType, Model, NUM_UNASSIGNED, decodeName, encodeName, getModel, type Text } from '@cygnus/protocol';
import { templates as vehicleTemplates, type VehicleSlot, type VehicleTemplate } from '@cygnus/vehicles';
import { CyncoderNode } from './devices/cyncoder';
import { EscNode } from './devices/esc';
import { GyroNode } from './devices/gyro';
import { LegacyCyncoderNode } from './devices/legacy-cyncoder';
import { OledNode, UsbCanNode } from './devices/oled';
import { PdhLargeNode, PdhSmallNode, SocRegNode } from './devices/power';
import { SealedServoNode } from './devices/sealed-servo';
import { Servo16Node } from './devices/servo16';
import type { SimNode, SimNodeOptions } from './node';
import { Prng } from './prng';
import { Simulation } from './simulation';
import { HobbyServo, MOTORS, type MotorSpec, type PowerFeed, type Shaft, type Thruster } from './world';

export interface ScenarioOptions {
  seed?: number;
  /** false: boards come out of the factory (number 63, no presets) — for the vehicle wizard. Default true. */
  assigned?: boolean;
  /** Bus and adapter carry CAN-FD (default true). */
  fd?: boolean;
  /** Vehicle scenarios: drive slots that accept a servo-board channel through one (PWM ESCs, hobby servos). */
  useServoChannels?: boolean;
}

export interface ScenarioInfo {
  id: string;
  name: Text;
  description: Text;
  category: 'bench' | 'demo' | 'vehicle';
}

/** Where a vehicle slot ended up in the simulation. */
export interface SlotPlacement {
  nodeId: string;
  /** Servo board channel (1..16) for channel slots. */
  channel?: number;
  /** Shaft the slot's actuator turns or sensor reads. */
  shaftId?: string;
}

// ---------------------------------------------------------------------------------------

/**
 * UID of a scenario board from the scenario id and the board's role (its node id): the same
 * scenario gives the same UIDs on every run (also its `assigned: false` variant), different
 * scenarios give different ones, so a project's uid48-keyed records do not match the wrong board.
 */
export function scenarioUid96(scenarioId: string, nodeId: string): Uint8Array {
  const key = `${scenarioId}/${nodeId}`;
  let h = 0x811c9dc5;
  for (let k = 0; k < key.length; k++) h = Math.imul(h ^ key.charCodeAt(k), 0x01000193) >>> 0;
  return new Prng(h).bytes(12);
}

/** Small helper that creates boards with scenario-derived UIDs and consistent numbering. */
export class ScenarioBuilder {
  readonly sim: Simulation;
  readonly assigned: boolean;
  private readonly used = new Map<number, Set<number>>();

  constructor(sim: Simulation, assigned = true) {
    this.sim = sim;
    this.assigned = assigned;
  }

  /** Base options: UID from the scenario and node id; number and name only when `assigned`. */
  opts(devType: number, o: { id: string; num?: number; name?: string; params?: Record<string, number>; feed?: PowerFeed | null }): SimNodeOptions {
    let num = NUM_UNASSIGNED;
    if (this.assigned) {
      // Numbers are unique per DEVTYPE (e.g. PDH and SoC regulator share DEVTYPE 8).
      let used = this.used.get(devType);
      if (!used) this.used.set(devType, (used = new Set(this.sim.nodes.filter((n) => n.def.devType === devType).map((n) => n.num))));
      num = o.num ?? 1;
      while (used.has(num) && num < 62) num++;
      used.add(num);
    }
    const out: SimNodeOptions = { id: o.id, uid96: scenarioUid96(this.sim.scenarioId, o.id), num };
    if (this.assigned && o.name) out.name = fitName(o.name);
    if (this.assigned && o.params) out.params = o.params;
    // A classic-only bus (roboRIO, MCP2515) needs boards in classic mode, or their FD stream
    // and firmware frames would be destroyed (PROTOCOL §1).
    if (!this.sim.bus.fd) out.params = { ...out.params, 'can.data_bitrate': 0 };
    if (o.feed) out.feed = o.feed;
    return out;
  }

  esc(o: {
    id: string;
    model?: typeof Model.ESC_20A | typeof Model.ESC_80A;
    motor: MotorSpec;
    shaft: Shaft;
    gear?: number;
    num?: number;
    name?: string;
    params?: Record<string, number>;
    feed?: PowerFeed | null;
  }): EscNode {
    const m = this.sim.world.addMotor(o.motor, o.shaft, o.gear ?? 1);
    const params = { 'motor.gear_ratio': o.gear ?? 1, ...o.params };
    return this.sim.addNode(new EscNode(o.model ?? Model.ESC_80A, { ...this.opts(DevType.MOTOR_CONTROLLER, { ...o, params }), motor: m }));
  }

  /** `mountRot` defaults to a random magnet angle (as assembled); use "zero here" to align it. */
  encoder(o: { id: string; shaft: Shaft | null; ratio?: number; mountRot?: number; num?: number; name?: string; params?: Record<string, number> }): CyncoderNode {
    const mountRot = o.mountRot ?? this.sim.rng.next();
    return this.sim.addNode(new CyncoderNode({ ...this.opts(DevType.ENCODER, o), shaft: o.shaft, ratio: o.ratio ?? 1, mountRot }));
  }

  /** Cyncoder 1.4 on the legacy v3 firmware: its own number space (DEVTYPE 10, CLASS 0/1), no CyCAN identity. */
  legacyEncoder(o: { id: string; shaft: Shaft | null; num: number; version?: 0 | 2 | 3; mountRot?: number }): LegacyCyncoderNode {
    const mountRot = o.mountRot ?? this.sim.rng.next();
    return this.sim.addNode(
      new LegacyCyncoderNode({ id: o.id, uid96: scenarioUid96(this.sim.scenarioId, o.id), num: o.num, shaft: o.shaft, mountRot, ...(o.version !== undefined ? { version: o.version } : {}) }),
    );
  }

  gyro(o: { id: string; num?: number; name?: string }): GyroNode {
    return this.sim.addNode(new GyroNode(this.opts(DevType.GYRO, o)));
  }

  sealedServo(o: { id: string; shaft?: Shaft | null; num?: number; name?: string; params?: Record<string, number>; feed?: PowerFeed | null }): SealedServoNode {
    return this.sim.addNode(new SealedServoNode({ ...this.opts(DevType.SERVO_CONTROLLER, o), shaft: o.shaft ?? null }));
  }

  servo16(o: { id: string; num?: number; name?: string; feed?: PowerFeed | null }): Servo16Node {
    return this.sim.addNode(new Servo16Node(this.opts(DevType.SERVO_CONTROLLER, o)));
  }

  pdhLarge(o: { id: string; num?: number; name?: string; fuseA?: number[] }): PdhLargeNode {
    const n = new PdhLargeNode({ ...this.opts(DevType.POWER_DISTRIBUTION, o), ...(o.fuseA ? { fuseA: o.fuseA } : {}) });
    return this.sim.addNode(n);
  }

  pdhSmall(o: { id: string; num?: number; name?: string; fuseA?: number[] }): PdhSmallNode {
    return this.sim.addNode(new PdhSmallNode({ ...this.opts(DevType.POWER_DISTRIBUTION, o), ...(o.fuseA ? { fuseA: o.fuseA } : {}) }));
  }

  soc(o: { id: string; num?: number; name?: string; outputV?: 5 | 12 | 19; loadA?: number; feed?: PowerFeed | null }): SocRegNode {
    return this.sim.addNode(new SocRegNode({ ...this.opts(DevType.POWER_DISTRIBUTION, o), outputV: o.outputV ?? 12, loadA: o.loadA ?? 1.8 }));
  }

  oled(o: { id: string; num?: number; name?: string; params?: Record<string, number> }): OledNode {
    return this.sim.addNode(new OledNode(this.opts(DevType.MISC, o)));
  }

  usbCan(o: { id: string; num?: number; name?: string }): UsbCanNode {
    return this.sim.addNode(new UsbCanNode(this.opts(DevType.MISC, o)));
  }
}

/** Names are 21 UTF-8 bytes on the board; encodeName truncates on a character boundary. */
function fitName(s: string): string {
  return decodeName(encodeName(s));
}

// ---------------------------------------------------------------------------------------
// Hand-made scenarios

function benchFlywheel(o: ScenarioOptions): Simulation {
  const sim = new Simulation({ seed: o.seed ?? 1, fd: o.fd ?? true, scenarioId: 'bench.flywheel', label: { tr: 'Volan tezgâhı', en: 'Flywheel bench' } });
  const b = new ScenarioBuilder(sim, o.assigned ?? true);
  const fly = sim.world.addShaft({ id: 'flywheel', label: 'Volan / Flywheel', inertia: 0.004, viscous: 2e-4, coulomb: 0.03 });
  b.esc({ id: 'esc', model: Model.ESC_80A, motor: MOTORS.neo, shaft: fly, num: 1, name: 'Volan', params: { 'fb.source': 1 } });
  b.usbCan({ id: 'usbcan', num: 1 });
  return sim;
}

function benchArm(o: ScenarioOptions): Simulation {
  const sim = new Simulation({ seed: o.seed ?? 1, fd: o.fd ?? true, scenarioId: 'bench.arm', label: { tr: 'Kol eklemi tezgâhı', en: 'Arm joint bench' } });
  const b = new ScenarioBuilder(sim, o.assigned ?? true);
  // 0.6 m arm with a 2 kg end mass: ~12 N·m when horizontal; it hangs straight down at 0.
  const arm = sim.world.addShaft({
    id: 'arm',
    label: 'Kol / Arm',
    inertia: 0.75,
    viscous: 0.05,
    coulomb: 0.4,
    gravity: { torqueNm: 12, downRot: 0 },
    stops: { minRot: -0.05, maxRot: 0.45, restitution: 0.1 },
  });
  b.esc({
    id: 'esc',
    model: Model.ESC_80A,
    motor: MOTORS.neo,
    shaft: arm,
    gear: 60,
    num: 1,
    name: 'Kol eklemi',
    params: { 'fb.source': 2, 'fb.remote_num': 1, 'fb.remote_ratio': 1, 'pos.kp': 2, 'limits.supply_current_a': 40 },
  });
  b.encoder({ id: 'enc', shaft: arm, num: 1, name: 'Kol açısı', mountRot: 0 });
  b.usbCan({ id: 'usbcan', num: 1 });
  return sim;
}

function factoryFresh(o: ScenarioOptions): Simulation {
  const sim = new Simulation({ seed: o.seed ?? 7, fd: o.fd ?? true, scenarioId: 'factory.fresh', label: { tr: 'Fabrika çıkışı kartlar', en: 'Factory-fresh boards' } });
  const fresh = new ScenarioBuilder(sim, false);
  const set = new ScenarioBuilder(sim, true);
  const w = sim.world;
  const sh = (id: string): Shaft => w.addShaft({ id, inertia: 0.002, viscous: 1e-4, coulomb: 0.02 });
  fresh.esc({ id: 'esc-a', model: Model.ESC_80A, motor: MOTORS.neo, shaft: sh('shaft-a') });
  fresh.esc({ id: 'esc-b', model: Model.ESC_80A, motor: MOTORS.neo, shaft: sh('shaft-b') });
  fresh.esc({ id: 'esc-c', model: Model.ESC_20A, motor: MOTORS.neo550, shaft: sh('shaft-c') });
  // Two encoders that both left the bench as #1: they will find each other and fall silent.
  const encShaft = sh('shaft-enc');
  set.encoder({ id: 'enc-a', shaft: encShaft, num: 1, name: 'Encoder A' });
  set.encoder({ id: 'enc-b', shaft: sh('shaft-enc2'), name: 'Encoder B' }).setFlashNum(1);
  fresh.encoder({ id: 'enc-c', shaft: encShaft });
  fresh.gyro({ id: 'gyro' });
  fresh.servo16({ id: 'servo16' });
  fresh.sealedServo({ id: 'sealed' });
  set.pdhLarge({ id: 'pdh', num: 1, name: 'Ana güç' });
  return sim;
}

function allDevices(o: ScenarioOptions): Simulation {
  const sim = new Simulation({ seed: o.seed ?? 3, fd: o.fd ?? true, scenarioId: 'all.devices', label: { tr: 'Tüm cihazlar', en: 'All devices' } });
  const b = new ScenarioBuilder(sim, o.assigned ?? true);
  const w = sim.world;
  const pdh = b.pdhLarge({ id: 'pdh_large', num: 1, name: 'Güç dağıtım' });
  const small = w.addShaft({ id: 'small', label: 'Küçük motor', inertia: 2e-4, viscous: 2e-5, coulomb: 0.005 });
  const fly = w.addShaft({ id: 'flywheel', label: 'Volan', inertia: 0.004, viscous: 2e-4, coulomb: 0.03 });
  b.esc({ id: 'esc20a', model: Model.ESC_20A, motor: MOTORS.neo550, shaft: small, num: 1, name: 'ESC 20A', feed: pdh.channel(1), params: { 'fb.source': 1 } });
  b.esc({ id: 'esc80a', model: Model.ESC_80A, motor: MOTORS.neo, shaft: fly, num: 2, name: 'ESC 80A', feed: pdh.channel(2), params: { 'fb.source': 1 } });
  b.encoder({ id: 'cyncoder', shaft: fly, num: 1, name: 'Cyncoder' });
  b.gyro({ id: 'gyro', num: 1, name: 'Jiroskop' });
  const s16 = b.servo16({ id: 'servo16', num: 1, name: 'Servo kartı', feed: pdh.channel(3) });
  s16.setSink(1, { kind: 'servo', servo: new HobbyServo() });
  s16.setSink(2, { kind: 'servo', servo: new HobbyServo() });
  const joint = w.addShaft({ id: 'joint', label: 'Sızdırmaz servo çıkışı', inertia: 5e-3, viscous: 0.01, coulomb: 0.1, gravity: { torqueNm: 1.5, downRot: 0 } });
  b.sealedServo({ id: 'sealed_servo', shaft: joint, num: 2, name: 'Sızdırmaz servo', feed: pdh.channel(4) });
  b.pdhSmall({ id: 'pdh_small', num: 2, name: 'Küçük güç' });
  b.soc({ id: 'soc_reg', num: 3, name: 'SoC 12V', feed: pdh.channel(5) });
  b.oled({ id: 'oled', num: 1, name: 'Ekran', params: { 'watch.1.devtype': DevType.MOTOR_CONTROLLER, 'watch.1.num': 2 } });
  b.usbCan({ id: 'usbcan', num: 2, name: 'USB-CAN' });
  // A board still on the legacy FRC firmware, sharing the bus (and the small motor's shaft).
  b.legacyEncoder({ id: 'cyncoder_v3', shaft: small, num: 3 });
  sim.setFeed('soc_reg', pdh.channel(5));
  return sim;
}

function legacyCyncoder(o: ScenarioOptions): Simulation {
  // FRC bus: classic CAN unless asked otherwise, as on a roboRIO.
  const sim = new Simulation({ seed: o.seed ?? 5, fd: o.fd ?? false, scenarioId: 'legacy.cyncoder', label: { tr: 'Eski Cyncoder', en: 'Legacy Cyncoder' } });
  const b = new ScenarioBuilder(sim, o.assigned ?? true);
  const w = sim.world;
  const sh = (id: string, label: string): Shaft => w.addShaft({ id, label, inertia: 0.002, viscous: 1e-4, coulomb: 0.02 });
  b.legacyEncoder({ id: 'v3-a', shaft: sh('shaft-a', 'Eski A / Legacy A'), num: 1 });
  b.legacyEncoder({ id: 'v3-b', shaft: sh('shaft-b', 'Eski B / Legacy B'), num: 2 });
  b.encoder({ id: 'cycan', shaft: sh('shaft-c', 'CyCAN'), num: 1, name: 'Cyncoder 1.5' });
  return sim;
}

const HAND: Array<ScenarioInfo & { build: (o: ScenarioOptions) => Simulation }> = [
  {
    id: 'bench.flywheel',
    category: 'bench',
    name: { tr: 'Volan tezgâhı', en: 'Flywheel bench' },
    description: { tr: 'Tek ESC 80A ve volan: hız döngüsü ayarı.', en: 'One ESC 80A and a flywheel: velocity loop tuning.' },
    build: benchFlywheel,
  },
  {
    id: 'bench.arm',
    category: 'bench',
    name: { tr: 'Kol eklemi tezgâhı', en: 'Arm joint bench' },
    description: {
      tr: 'ESC 80A + Cyncoder + yerçekimli kol: konum döngüsü ve profil ayarı.',
      en: 'ESC 80A + Cyncoder + gravity-loaded arm: position loop and profile tuning.',
    },
    build: benchArm,
  },
  {
    id: 'factory.fresh',
    category: 'demo',
    name: { tr: 'Fabrika çıkışı kartlar', en: 'Factory-fresh boards' },
    description: {
      tr: 'Atanmamış ve aynı numaralı kartlar: keşif ve çakışma çözme gösterimi.',
      en: 'Unassigned and same-numbered boards: discovery and conflict resolution demo.',
    },
    build: factoryFresh,
  },
  {
    id: 'legacy.cyncoder',
    category: 'demo',
    name: { tr: 'Eski Cyncoder', en: 'Legacy Cyncoder' },
    description: {
      tr: 'Eski FRC protokolündeki iki Cyncoder 1.4 ve CyCAN konuşan bir Cyncoder aynı hatta.',
      en: 'Two Cyncoder 1.4 boards on the legacy FRC protocol and one CyCAN Cyncoder on one bus.',
    },
    build: legacyCyncoder,
  },
  {
    id: 'all.devices',
    category: 'demo',
    name: { tr: 'Tüm cihazlar', en: 'All devices' },
    description: { tr: 'Her modelden bir kart ve eski protokolde bir Cyncoder.', en: 'One board of every model and a Cyncoder on the legacy protocol.' },
    build: allDevices,
  },
];

// ---------------------------------------------------------------------------------------
// Vehicle scenarios

const ROBOT_MASS: Record<VehicleTemplate['category'], number> = {
  frc: 55,
  ground: 30,
  air: 2.2,
  underwater: 14,
  surface: 25,
  defense: 40,
  arm: 5,
  custom: 10,
};

/** Template diagram units (−1..1) to metres. */
const SCALE: Record<VehicleTemplate['category'], number> = {
  frc: 0.38,
  ground: 0.45,
  air: 0.25,
  underwater: 0.3,
  surface: 0.6,
  defense: 0.4,
  arm: 0.3,
  custom: 0.3,
};

function firstDevice(s: VehicleSlot): string | undefined {
  return s.accepts.find((a) => a.via === 'device')?.model;
}

function acceptsChannel(s: VehicleSlot): boolean {
  return s.accepts.some((a) => a.via === 'channel');
}

/**
 * Builds a simulation from a vehicle template: one board per slot, mechanics wired by role
 * (swerve steer motor and its encoder on one shaft, propeller/thruster loads, turret axes,
 * gravity-loaded arm joints), boards spread over the power distribution channels.
 * With `assigned: false` boards are factory-fresh, to try the vehicle setup wizard.
 */
export function buildVehicleScenario(template: VehicleTemplate, o: ScenarioOptions = {}): Simulation {
  const sim = new Simulation({ seed: o.seed ?? 11, fd: o.fd ?? true, label: template.name, scenarioId: VEHICLE_PREFIX + template.id });
  const assigned = o.assigned ?? true;
  const b = new ScenarioBuilder(sim, assigned);
  const w = sim.world;
  const cat = template.category;
  const mass = ROBOT_MASS[cat];
  const scale = SCALE[cat];
  const slots = template.slots;
  const placements = sim.slotPlacements;
  const name = (s: VehicleSlot): string => s.label.tr;
  const presets = (s: VehicleSlot, extra: Record<string, number> = {}): Record<string, number> => ({ ...s.presets, ...extra });

  // Power first, so actuators can be fed from its channels.
  const powerSlot = slots.find((s) => s.role === 'power');
  let pdh: PdhLargeNode | PdhSmallNode | null = null;
  if (powerSlot) {
    const prefer = cat === 'air' ? 'pdh_small' : 'pdh_large';
    const model = powerSlot.accepts.some((a) => a.model === prefer) ? prefer : firstDevice(powerSlot);
    pdh =
      model === 'pdh_small'
        ? b.pdhSmall({ id: powerSlot.id, num: powerSlot.suggestedNum ?? 1, name: name(powerSlot) })
        : b.pdhLarge({ id: powerSlot.id, num: powerSlot.suggestedNum ?? 1, name: name(powerSlot) });
    placements[powerSlot.id] = { nodeId: pdh.id };
  }
  const actuatorSlots = slots.filter((s) => ['drive', 'steer', 'thruster', 'propeller', 'joint', 'pan', 'tilt'].includes(s.role));
  const channelCount = pdh ? pdh.channels.length : 0;
  const perChannel = new Map<number, number>();
  const feedFor = (s: VehicleSlot): PowerFeed | null => {
    if (!pdh) return null;
    const i = actuatorSlots.indexOf(s);
    if (i < 0) return null;
    const ch = (i % channelCount) + 1;
    perChannel.set(ch, (perChannel.get(ch) ?? 0) + 1);
    return pdh.channel(ch);
  };

  let servoBoard: Servo16Node | null = null;
  let nextChannel = 1;
  const channelFor = (s: VehicleSlot): { board: Servo16Node; channel: number } => {
    if (!servoBoard) servoBoard = b.servo16({ id: 'servo16', num: 1, name: 'Servo kartı', feed: pdh ? pdh.channel(channelCount) : null });
    const channel = nextChannel++;
    placements[s.id] = { nodeId: servoBoard.id, channel };
    return { board: servoBoard, channel };
  };
  const useChannel = (s: VehicleSlot): boolean => acceptsChannel(s) && (o.useServoChannels === true || !firstDevice(s));

  const shafts = new Map<string, Shaft>();
  const wheelR = cat === 'frc' ? 0.0508 : 0.08;
  const drives: Array<{ slot: VehicleSlot; shaft: Shaft }> = [];
  const thrusters: Thruster[] = [];

  // Shared drive shafts: tank sides drive one gearbox each (several motors on one shaft).
  const sideShaft = new Map<string, Shaft>();

  for (const s of slots) {
    const model = firstDevice(s);
    const x = s.pos.x * scale;
    const y = s.pos.y * scale;
    switch (s.role) {
      case 'drive': {
        const nDrive = slots.filter((q) => q.role === 'drive').length;
        const shared = template.id === 'frc.tank';
        const key = shared ? (s.group ?? (x < 0 ? 'left' : 'right')) : s.id;
        let shaft = sideShaft.get(key);
        if (!shaft) {
          const share = shared ? 2 : Math.max(1, nDrive);
          shaft = w.addShaft({ id: `${key}.wheel`, label: `${key} wheel`, inertia: (mass / share) * wheelR * wheelR + 0.002, viscous: 0.01, coulomb: 0.02 * mass * 9.81 * wheelR / share });
          sideShaft.set(key, shaft);
          drives.push({ slot: s, shaft });
        }
        shafts.set(s.id, shaft);
        const gear = cat === 'frc' ? (template.id === 'frc.swerve4' ? 6.75 : 8.45) : 20;
        const esc = b.esc({
          id: s.id,
          model: model === 'esc20a' ? Model.ESC_20A : Model.ESC_80A,
          motor: MOTORS.neo,
          shaft,
          gear,
          num: s.suggestedNum,
          name: name(s),
          params: presets(s, { 'fb.source': 1 }),
          feed: feedFor(s),
        });
        placements[s.id] = { nodeId: esc.id, shaftId: shaft.id };
        break;
      }
      case 'steer': {
        const swerve = template.id === 'frc.swerve4';
        const shaft = w.addShaft({
          id: `${s.id}.shaft`,
          label: `${s.id}`,
          inertia: swerve ? 0.02 : 0.05,
          viscous: 0.05,
          coulomb: swerve ? 0.8 : 1.5,
          ...(swerve ? {} : { stops: { minRot: -0.1, maxRot: 0.1 } }),
        });
        shafts.set(s.id, shaft);
        if (useChannel(s)) {
          const { board, channel } = channelFor(s);
          board.setSink(channel, { kind: 'servo', servo: new HobbyServo(shaft) });
          placements[s.id]!.shaftId = shaft.id;
          break;
        }
        if (model === 'sealed_servo') {
          const n = b.sealedServo({ id: s.id, shaft, num: s.suggestedNum, name: name(s), params: presets(s), feed: feedFor(s) });
          placements[s.id] = { nodeId: n.id, shaftId: shaft.id };
          break;
        }
        const encSlot = slots.find((q) => q.role === 'steerEncoder' && (q.group === s.group || !s.group));
        const gear = swerve ? 150 / 7 : 50;
        const extra: Record<string, number> = {};
        // Gains for the swerve steer come from the template presets (the same the vehicle wizard writes).
        if (encSlot) Object.assign(extra, { 'fb.source': 2, 'fb.remote_num': encSlot.suggestedNum ?? 1, 'fb.remote_ratio': 1 });
        const esc = b.esc({
          id: s.id,
          model: Model.ESC_20A,
          motor: MOTORS.neo550,
          shaft,
          gear,
          num: s.suggestedNum,
          name: name(s),
          params: presets(s, extra),
          feed: feedFor(s),
        });
        placements[s.id] = { nodeId: esc.id, shaftId: shaft.id };
        break;
      }
      case 'thruster':
      case 'propeller': {
        const air = s.role === 'propeller';
        // A counter-rotating propeller is mirrored: it pushes forward while spinning backwards.
        const sense = s.spin === 'ccw' ? -1 : 1;
        const shaft = w.addShaft({
          id: `${s.id}.prop`,
          label: `${s.id}`,
          inertia: air ? 4e-5 : 6e-5,
          viscous: 1e-6,
          coulomb: 0.002,
          prop: air ? { kT: 1.15e-5 * sense, kQ: 1.5e-7 } : { kT: 1.5e-4, kQ: 1.6e-6 },
        });
        shafts.set(s.id, shaft);
        const spec = air ? MOTORS.drone : MOTORS.thruster;
        if (useChannel(s) || !model) {
          const { board, channel } = channelFor(s);
          const pwm = w.addPwmEsc(w.addMotor(spec, shaft, 1), !air);
          pwm.feed = feedFor(s) ?? w.battery.feed;
          board.setSink(channel, { kind: 'pwm', target: pwm });
          placements[s.id]!.shaftId = shaft.id;
        } else {
          const esc = b.esc({
            id: s.id,
            model: model === 'esc80a' ? Model.ESC_80A : Model.ESC_20A,
            motor: spec,
            shaft,
            num: s.suggestedNum,
            name: name(s),
            params: presets(s, { 'fb.source': 0, 'motor.invert': s.spin === 'ccw' ? 1 : 0 }),
            feed: feedFor(s),
          });
          placements[s.id] = { nodeId: esc.id, shaftId: shaft.id };
        }
        thrusters.push({
          shaft,
          x,
          y,
          headingDeg: s.headingDeg ?? 0,
          vertical: air || (s.headingDeg === undefined && cat !== 'surface'),
          spin: s.spin === 'ccw' ? -1 : 1,
        });
        break;
      }
      case 'joint':
      case 'pan':
      case 'tilt':
      case 'surface':
      case 'gripper':
      case 'aux': {
        const idx = slots.filter((q) => q.role === 'joint').indexOf(s);
        const gravity =
          s.role === 'joint' && idx > 0
            ? { torqueNm: 6 / idx, downRot: 0 }
            : s.role === 'tilt'
              ? { torqueNm: 8, downRot: -0.25 }
              : undefined;
        const shaft = w.addShaft({
          id: `${s.id}.shaft`,
          label: `${s.id}`,
          inertia: s.role === 'pan' ? 0.6 : s.role === 'tilt' ? 0.3 : 0.02,
          viscous: 0.02,
          coulomb: s.role === 'pan' ? 0.6 : 0.05,
          ...(gravity ? { gravity } : {}),
          ...(s.role === 'tilt' ? { stops: { minRot: -0.05, maxRot: 0.2 }, initialRot: -0.05 } : {}),
        });
        shafts.set(s.id, shaft);
        if (useChannel(s) || !model) {
          const { board, channel } = channelFor(s);
          board.setSink(channel, { kind: 'servo', servo: new HobbyServo(shaft) });
          placements[s.id]!.shaftId = shaft.id;
        } else if (model === 'sealed_servo') {
          const n = b.sealedServo({ id: s.id, shaft, num: s.suggestedNum, name: name(s), params: presets(s), feed: feedFor(s) });
          placements[s.id] = { nodeId: n.id, shaftId: shaft.id };
        } else {
          const encSlot = slots.find((q) => q.role === 'encoder' && q.id.startsWith(`${s.id}.`));
          const extra: Record<string, number> = encSlot ? { 'fb.source': 2, 'fb.remote_num': encSlot.suggestedNum ?? 1 } : { 'fb.source': 1 };
          const esc = b.esc({
            id: s.id,
            model: model === 'esc20a' ? Model.ESC_20A : Model.ESC_80A,
            motor: MOTORS.neo,
            shaft,
            gear: 100,
            num: s.suggestedNum,
            name: name(s),
            params: presets(s, extra),
            feed: feedFor(s),
          });
          placements[s.id] = { nodeId: esc.id, shaftId: shaft.id };
        }
        break;
      }
    }
  }

  // Sensors and infrastructure, once the shafts they read exist.
  for (const s of slots) {
    switch (s.role) {
      case 'steerEncoder':
      case 'jointEncoder':
      case 'encoder': {
        const owner =
          slots.find((q) => (q.role === 'steer' || q.role === 'joint') && q.group !== undefined && q.group === s.group) ??
          slots.find((q) => s.id.startsWith(`${q.id}.`)) ??
          slots.find((q) => q.role === 'drive' && q.group !== undefined && s.id.endsWith(q.group.slice(0, 1)));
        const shaft = (owner && shafts.get(owner.id)) ?? null;
        const n = b.encoder({ id: s.id, shaft, num: s.suggestedNum, name: name(s), params: presets(s) });
        placements[s.id] = { nodeId: n.id, ...(shaft ? { shaftId: shaft.id } : {}) };
        break;
      }
      case 'gyro': {
        const n = b.gyro({ id: s.id, num: s.suggestedNum, name: name(s) });
        placements[s.id] = { nodeId: n.id };
        break;
      }
      case 'computePower': {
        const n = b.soc({ id: s.id, num: s.suggestedNum ?? 2, name: name(s), feed: null });
        placements[s.id] = { nodeId: n.id };
        break;
      }
      case 'display': {
        const n = b.oled({ id: s.id, num: s.suggestedNum, name: name(s) });
        placements[s.id] = { nodeId: n.id };
        break;
      }
    }
  }
  // Shared channels get a fuse sized for their loads.
  if (pdh) for (const [ch, n] of perChannel) if (n > 1) pdh.fuses[ch - 1]!.ratingA *= n;

  configureBody(sim, template, drives, shafts, thrusters, mass, scale, wheelR);
  return sim;
}

function configureBody(
  sim: Simulation,
  template: VehicleTemplate,
  drives: Array<{ slot: VehicleSlot; shaft: Shaft }>,
  shafts: Map<string, Shaft>,
  thrusters: Thruster[],
  mass: number,
  scale: number,
  wheelR: number,
): void {
  const w = sim.world;
  const id = template.id;
  if (id === 'frc.swerve4') {
    const modules = ['fl', 'fr', 'bl', 'br'].flatMap((g) => {
      const d = template.slots.find((s) => s.group === g && s.role === 'drive');
      const st = template.slots.find((s) => s.group === g && s.role === 'steer');
      const ds = d && shafts.get(d.id);
      const ss = st && shafts.get(st.id);
      return d && ds && ss ? [{ x: d.pos.x * scale, y: d.pos.y * scale, drive: ds, steer: ss }] : [];
    });
    w.setBody({ kind: 'swerve', wheelRadiusM: wheelR, modules });
  } else if (id === 'frc.mecanum4') {
    const g = (k: string): Shaft => shafts.get(`${k}.drive`)!;
    w.setBody({ kind: 'mecanum', wheelRadiusM: wheelR, lx: 0.25, ly: 0.25, fl: g('fl'), fr: g('fr'), rl: g('bl'), rr: g('br') });
  } else if (id === 'ground.ackermann') {
    const steer = shafts.get('steer');
    if (steer) w.setBody({ kind: 'ackermann', drive: drives.map((d) => d.shaft), steer, wheelRadiusM: wheelR, wheelbaseM: 0.5, maxSteerDeg: 30 });
  } else if (drives.length > 0) {
    const left = drives.filter((d) => d.slot.pos.x < 0).map((d) => d.shaft);
    const right = drives.filter((d) => d.slot.pos.x >= 0).map((d) => d.shaft);
    w.setBody({ kind: 'differential', left, right, wheelRadiusM: wheelR, trackM: 0.55, slip: id.startsWith('ground.skid') ? 0.6 : 0.85 });
  } else if (thrusters.length > 0) {
    const medium = template.category === 'air' ? 'air' : template.category === 'surface' ? 'surface' : 'water';
    w.setBody({ kind: 'thrust', medium, massKg: mass, thrusters });
  } else if (id === 'defense.turret') {
    const pan = shafts.get('pan');
    if (pan) w.setBody({ kind: 'turret', pan, tilt: shafts.get('tilt') ?? null });
  }
}

// ---------------------------------------------------------------------------------------

const VEHICLE_PREFIX = 'vehicle.';

/** Every scenario the simulator can build: hand-made ones first, then one per vehicle template. */
export const scenarios: readonly ScenarioInfo[] = [
  ...HAND.map(({ id, name, description, category }) => ({ id, name, description, category })),
  ...vehicleTemplates
    .filter((t) => t.slots.length > 0)
    .map((t) => ({ id: VEHICLE_PREFIX + t.id, name: t.name, description: t.description, category: 'vehicle' as const })),
];

export function createScenario(id: string, o: ScenarioOptions = {}): Simulation {
  const hand = HAND.find((s) => s.id === id);
  let sim: Simulation;
  if (hand) {
    sim = hand.build(o);
  } else if (id.startsWith(VEHICLE_PREFIX)) {
    const t = vehicleTemplates.find((x) => x.id === id.slice(VEHICLE_PREFIX.length));
    if (!t) throw new Error(`unknown vehicle template in scenario ${id}`);
    sim = buildVehicleScenario(t, o);
  } else throw new Error(`unknown scenario ${id}`);
  return sim;
}

/** Catalog name of a node's model, for panels that list boards. */
export function modelName(node: SimNode): Text {
  if (node instanceof LegacyCyncoderNode) return CYNCODER_V3_DEF.name;
  return getModel(node.def.model)?.name ?? { tr: node.def.key, en: node.def.key };
}
