import { describe, expect, it } from 'vitest';
import { getTemplate, planApply, type SlotBinding, type VehicleTemplate } from '@cygnus/vehicles';
import {
  SEQ_IDLE,
  addCustomSlot,
  baseTemplate,
  bindSlot,
  bindingFor,
  candidatesFor,
  effectiveTemplate,
  fillSuggestedNums,
  groupPlan,
  moveCustomSlot,
  numberClashes,
  removeCustomSlot,
  seqCurrent,
  seqOrder,
  seqReducer,
  slotStatuses,
  updateCustomSlot,
  type DeviceLite,
} from './model';
import { isVehicleSetup } from './project';

const swerve = getTemplate('frc.swerve4') as VehicleTemplate;
const rov = getTemplate('underwater.rov8') as VehicleTemplate;

let uidSeq = 0;
function dev(model: string, o: Partial<DeviceLite> = {}): DeviceLite {
  uidSeq++;
  const devType = { esc20a: 2, esc80a: 2, cyncoder: 7, gyro: 4, servo16: 12, pdh_large: 8, pdh_small: 8, soc_reg: 8 }[model] ?? 0;
  return { uid48: `a0000000${String(uidSeq).padStart(4, '0')}`, online: true, model, devType, num: uidSeq, name: '', unassigned: false, conflict: false, ...o };
}
const asDevice = (d: DeviceLite): SlotBinding => ({ kind: 'device', uid48: d.uid48, model: d.model ?? '' });
const label = (n: number) => ({ tr: `Yuva ${n}`, en: `Slot ${n}` });

describe('slot status', () => {
  it('empty, online, lost, external and incompatible', () => {
    const esc = dev('esc80a');
    const gone = dev('esc80a', { online: false });
    const enc = dev('cyncoder');
    const bindings: Record<string, SlotBinding> = {
      'fl.drive': asDevice(esc),
      'fr.drive': asDevice(gone),
      'bl.drive': { kind: 'external', canId: 3, note: 'SPARK MAX' },
      // An encoder on a motor slot is a model mismatch.
      'br.drive': asDevice(enc),
    };
    const st = slotStatuses(swerve, bindings, [esc, gone, enc]);
    expect(st['fl.drive']).toBe('online');
    expect(st['fr.drive']).toBe('lost');
    expect(st['bl.drive']).toBe('external');
    expect(st['br.drive']).toBe('incompatible');
    expect(st['gyro']).toBe('empty');
  });

  it('a board bound twice marks the duplicate as incompatible; an unknown board is lost', () => {
    const esc = dev('esc80a');
    const st = slotStatuses(swerve, { 'fl.drive': asDevice(esc), 'fr.drive': asDevice(esc), 'bl.drive': { kind: 'device', uid48: 'ffffffffffff', model: 'esc80a' } }, [esc]);
    expect(st['fl.drive']).toBe('online');
    expect(st['fr.drive']).toBe('incompatible');
    expect(st['bl.drive']).toBe('lost');
  });

  it('an external device on a sensor slot is not allowed', () => {
    const st = slotStatuses(swerve, { gyro: { kind: 'external', note: '' } }, []);
    expect(st['gyro']).toBe('incompatible');
  });
});

describe('compatible boards', () => {
  const esc = dev('esc20a');
  const esc2 = dev('esc80a');
  const enc = dev('cyncoder');
  const gyro = dev('gyro');
  const servo = dev('servo16');
  const offline = dev('esc80a', { online: false });
  const all = [esc, esc2, enc, gyro, servo, offline];

  it('only boards the slot accepts, free ones first, offline ones never', () => {
    const slot = swerve.slots.find((s) => s.id === 'fl.drive')!;
    const bound = { 'fr.drive': asDevice(esc) };
    const c = candidatesFor(slot, bound, all);
    expect(c.map((x) => x.device.uid48)).toEqual([esc2.uid48, esc.uid48]);
    expect(c[1]!.boundTo).toEqual(['fr.drive']);
    expect(candidatesFor(swerve.slots.find((s) => s.id === 'gyro')!, {}, all).map((x) => x.device.uid48)).toEqual([gyro.uid48]);
  });

  it('a thruster slot is offered servo boards by channel, with the free channels', () => {
    const slot = rov.slots.find((s) => s.id === 'thr.h1')!;
    const bindings: Record<string, SlotBinding> = { 'thr.h2': { kind: 'channel', uid48: servo.uid48, model: 'servo16', channel: 1 } };
    const c = candidatesFor(slot, bindings, all).find((x) => x.device.uid48 === servo.uid48)!;
    expect(c.via).toBe('channel');
    expect(c.freeChannels[0]).toBe(2);
    expect(c.freeChannels).toHaveLength(15);
    expect(bindingFor(c)).toEqual({ kind: 'channel', uid48: servo.uid48, model: 'servo16', channel: 2 });
  });

  it('without a slot, every online board is listed', () => {
    expect(candidatesFor(null, {}, all)).toHaveLength(5);
  });
});

describe('binding edits', () => {
  it('binding a board moves it off its previous slot; channels coexist on one board', () => {
    const esc = dev('esc80a');
    const servo = dev('servo16');
    let b = bindSlot({}, 'fl.drive', asDevice(esc));
    b = bindSlot(b, 'fr.drive', asDevice(esc));
    expect(Object.keys(b)).toEqual(['fr.drive']);
    b = bindSlot(b, 'thr.h1', { kind: 'channel', uid48: servo.uid48, model: 'servo16', channel: 1 });
    b = bindSlot(b, 'thr.h2', { kind: 'channel', uid48: servo.uid48, model: 'servo16', channel: 2 });
    b = bindSlot(b, 'thr.h3', { kind: 'channel', uid48: servo.uid48, model: 'servo16', channel: 1 });
    expect(Object.keys(b).sort()).toEqual(['fr.drive', 'thr.h2', 'thr.h3']);
  });
});

describe('sequential assignment', () => {
  const order = seqOrder(swerve);

  it('visits required slots first and skips the ones already bound', () => {
    expect(order.indexOf('power')).toBe(order.length - 1);
    const s = seqReducer(SEQ_IDLE, { type: 'start', order, bindings: { 'fl.drive': { kind: 'external', note: '' } } });
    expect(seqCurrent(s)).toBe('fl.steer');
  });

  it('advances after an assignment, wraps to open slots, and finishes when all are bound', () => {
    let bindings: Record<string, SlotBinding> = {};
    let s = seqReducer(SEQ_IDLE, { type: 'start', order: ['a', 'b', 'c'], bindings });
    expect(seqCurrent(s)).toBe('a');
    s = seqReducer(s, { type: 'skip', bindings });
    expect(seqCurrent(s)).toBe('b');
    bindings = { b: { kind: 'external', note: '' } };
    s = seqReducer(s, { type: 'assigned', bindings });
    expect(seqCurrent(s)).toBe('c');
    bindings = { ...bindings, c: { kind: 'external', note: '' } };
    s = seqReducer(s, { type: 'assigned', bindings });
    expect(seqCurrent(s)).toBe('a'); // wrapped to the skipped one
    s = seqReducer(s, { type: 'skip', bindings });
    expect(seqCurrent(s)).toBe('a'); // nothing else open: stays
    bindings = { ...bindings, a: { kind: 'external', note: '' } };
    s = seqReducer(s, { type: 'assigned', bindings });
    expect(s.done).toBe(true);
    expect(seqCurrent(s)).toBeNull();
    s = seqReducer(s, { type: 'back' });
    expect(seqCurrent(s)).toBe('c');
    expect(seqReducer(s, { type: 'stop' })).toEqual(SEQ_IDLE);
  });

  it('a fully bound template is done at start', () => {
    const s = seqReducer(SEQ_IDLE, { type: 'start', order: ['a'], bindings: { a: { kind: 'external', note: '' } } });
    expect(s.done).toBe(true);
  });
});

describe('custom template editing', () => {
  it('adds, moves, edits and removes slots; ids and numbers stay unique', () => {
    let slots = addCustomSlot([], 'drive', label);
    slots = addCustomSlot(slots, 'drive', label, { x: 0.5, y: -2 });
    slots = addCustomSlot(slots, 'propeller', label);
    slots = addCustomSlot(slots, 'gyro', label);
    expect(slots.map((s) => s.id)).toEqual(['drive.1', 'drive.2', 'propeller.1', 'gyro.1']);
    expect(slots[1]!.pos).toEqual({ x: 0.5, y: -1 });
    expect(slots[2]!.spin).toBe('cw');
    expect(slots[2]!.accepts.some((a) => a.via === 'channel')).toBe(true);
    slots = moveCustomSlot(slots, 'drive.1', { x: -0.333, y: 0.777 });
    expect(slots[0]!.pos).toEqual({ x: -0.33, y: 0.78 });
    slots = updateCustomSlot(slots, 'drive.1', { required: false, headingDeg: 90, label: { tr: 'Sol', en: 'Left' } });
    expect(slots[0]).toMatchObject({ required: false, headingDeg: 90, label: { tr: 'Sol', en: 'Left' } });
    slots = removeCustomSlot(slots, 'drive.1');
    slots = addCustomSlot(slots, 'drive', label);
    expect(slots.map((s) => s.id)).toEqual(['drive.2', 'propeller.1', 'gyro.1', 'drive.1']);
    const nums = fillSuggestedNums(slots);
    // Both drive slots and the propeller are motor controllers (same DEVTYPE): distinct numbers.
    expect(new Set(nums.slice(0, 2).map((s) => s.suggestedNum)).size).toBe(2);
    expect(nums.find((s) => s.id === 'drive.1')!.suggestedNum).not.toBe(nums.find((s) => s.id === 'propeller.1')!.suggestedNum);
    const tpl = baseTemplate('custom.empty', slots)!;
    expect(tpl.slots).toHaveLength(4);
    expect(tpl.slots.every((s) => s.suggestedNum !== undefined)).toBe(true);
    expect(isVehicleSetup({ customSlots: slots, tweaks: {} })).toBe(true);
    expect(isVehicleSetup({ customSlots: [{ id: 1 }], tweaks: {} })).toBe(false);
  });
});

describe('tweaks and the plan', () => {
  it('direction, gear ratio and number tweaks reach planApply with the right catalog keys', () => {
    const esc = dev('esc80a', { num: 30, name: 'x' });
    const enc = dev('cyncoder', { num: 30, name: 'y' });
    const bindings: Record<string, SlotBinding> = { 'fl.drive': asDevice(esc), 'fl.enc': asDevice(enc) };
    const tpl = effectiveTemplate(swerve, { 'fl.drive': { invert: true, gearRatio: 6.12, num: 9 }, 'fl.enc': { invert: true } }, bindings);
    const drive = tpl.slots.find((s) => s.id === 'fl.drive')!;
    expect(drive.presets).toMatchObject({ 'motor.invert': 1, 'motor.gear_ratio': 6.12 });
    expect(drive.suggestedNum).toBe(9);
    expect(tpl.slots.find((s) => s.id === 'fl.enc')!.presets).toEqual({ 'enc.invert': 1 });
    const plan = planApply(tpl, { templateId: tpl.id, name: 'v', bindings }, [
      { uid48: esc.uid48, model: 'esc80a', devType: 2, num: 30, name: 'x' },
      { uid48: enc.uid48, model: 'cyncoder', devType: 7, num: 30, name: 'y' },
    ]);
    const groups = groupPlan(plan);
    expect(groups).toHaveLength(2);
    const g = groups.find((x) => x.uid48 === esc.uid48)!;
    expect(g.num).toEqual([expect.objectContaining({ kind: 'assignNum', from: 30, to: 9 })]);
    expect(g.name).toHaveLength(1);
    expect(g.params.map((p) => (p.kind === 'setParam' ? p.key : ''))).toEqual(expect.arrayContaining(['motor.invert', 'motor.gear_ratio', 'motor.idle_mode']));
  });

  it('flags two slots of one device type that would get the same number', () => {
    const a = dev('esc80a');
    const b = dev('esc80a');
    const bindings = { 'fl.drive': asDevice(a), 'fr.drive': asDevice(b) };
    const tpl = effectiveTemplate(swerve, { 'fr.drive': { num: 1 } }, bindings);
    expect([...numberClashes(tpl, bindings)].sort()).toEqual(['fl.drive', 'fr.drive']);
    expect(numberClashes(swerve, bindings).size).toBe(0);
  });
});
