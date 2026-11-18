import { describe, expect, it } from 'vitest';
import { getTemplate, planApply, templateCategories, templates, validateConfig, validateTemplate } from '../src';
import type { PlanDevice, VehicleConfig } from '../src';

const tpl = (id: string) => {
  const x = getTemplate(id);
  if (!x) throw new Error(id);
  return x;
};

const COUNTS: Record<string, number> = {
  'frc.swerve4': 14, 'frc.tank': 10, 'frc.mecanum4': 6, 'ground.skid4': 7, 'ground.skid6': 9, 'ground.ackermann': 7,
  'air.quadx': 7, 'air.quadplus': 7, 'air.hexax': 9, 'air.octox': 11, 'air.plane': 8,
  'underwater.rov6': 10, 'underwater.rov8': 12, 'surface.usv2': 5, 'defense.turret': 6, 'arm.arm4': 9, 'custom.empty': 0,
};

describe('templates', () => {
  it('has all 17 templates with unique ids and known categories', () => {
    expect(new Set(templates.map((x) => x.id)).size).toBe(templates.length);
    expect(templates.map((x) => x.id).sort()).toEqual(Object.keys(COUNTS).sort());
    const cats = new Set(templateCategories.map((c) => c.id));
    for (const x of templates) expect(cats.has(x.category)).toBe(true);
  });

  it.each(templates.map((x) => [x.id, x] as const))('%s passes validateTemplate and has expected slot count', (id, x) => {
    expect(validateTemplate(x)).toEqual([]);
    expect(x.slots.length).toBe(COUNTS[id]);
  });

  it('propellers are balanced and neighbours counter-rotate', () => {
    for (const id of ['air.quadx', 'air.quadplus', 'air.hexax', 'air.octox']) {
      const props = tpl(id).slots.filter((s) => s.role === 'propeller');
      expect(props.filter((s) => s.spin === 'cw').length).toBe(props.length / 2);
      const ring = [...props].sort((a, b) => Math.atan2(a.pos.x, a.pos.y) - Math.atan2(b.pos.x, b.pos.y));
      ring.forEach((s, i) => expect(s.spin).not.toBe(ring[(i + 1) % ring.length]?.spin));
    }
    const quad = tpl('air.quadx').slots;
    expect(quad.find((s) => s.id === 'm1')).toMatchObject({ spin: 'ccw', pos: { x: 0.6, y: 0.6 } });
    expect(quad.find((s) => s.id === 'm3')?.spin).toBe('cw');
  });

  it('swerve numbering follows the documented scheme', () => {
    const s = tpl('frc.swerve4').slots;
    expect(s.filter((x) => x.role === 'drive').map((x) => x.suggestedNum)).toEqual([1, 2, 3, 4]);
    expect(s.filter((x) => x.role === 'steer').map((x) => x.suggestedNum)).toEqual([5, 6, 7, 8]);
    expect(s.filter((x) => x.role === 'steerEncoder').map((x) => x.suggestedNum)).toEqual([1, 2, 3, 4]);
    expect(s.find((x) => x.id === 'fl.steer')?.presets).toMatchObject({ 'fb.source': 2 });
  });

  it('ROV horizontal thrusters sit at 45 degrees', () => {
    const h = tpl('underwater.rov6').slots.filter((s) => s.id.startsWith('thr.h'));
    expect(h.map((s) => s.headingDeg).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([45, 45, 315, 315]);
  });
});

const dev = (uid48: string, model: string, devType: number, num: number, name = ''): PlanDevice => ({ uid48, model, devType, num, name });
const ESC = 2, ENC = 7, GYRO = 4, SERVO = 12;

describe('validateConfig', () => {
  const t = tpl('frc.mecanum4');
  const ok: VehicleConfig = {
    templateId: t.id, name: 'x',
    bindings: Object.fromEntries(t.slots.filter((s) => s.required).map((s, i) => [s.id, { kind: 'device', uid48: `a${i}`, model: 'esc20a' }])) as VehicleConfig['bindings'],
  };

  it('accepts a complete config', () => {
    expect(validateConfig(t, ok)).toEqual([]);
  });

  it('reports each issue kind', () => {
    const codes = (b: VehicleConfig['bindings'], tp = t) => validateConfig(tp, { ...ok, templateId: tp.id, bindings: b }).map((i) => i.code);
    expect(codes({})).toContain('missingRequired');
    expect(codes({ ...ok.bindings, nope: { kind: 'device', uid48: 'zz', model: 'esc20a' } })).toContain('unknownSlot');
    expect(codes({ ...ok.bindings, 'fr.drive': { kind: 'device', uid48: 'A0', model: 'esc20a' } })).toContain('duplicateDevice');
    expect(codes({ ...ok.bindings, 'fl.drive': { kind: 'device', uid48: 'a9', model: 'gyro' } })).toContain('modelMismatch');
    expect(codes({ ...ok.bindings, 'fl.drive': { kind: 'channel', uid48: 'a9', model: 'servo16', channel: 1 } })).toContain('modelMismatch');
    expect(validateConfig(t, { ...ok, templateId: 'other' }).map((i) => i.code)).toContain('templateMismatch');
    expect(codes({ ...ok.bindings, gyro: { kind: 'external', note: 'n' } })).toContain('externalNotAllowed');
    expect(codes({ ...ok.bindings, 'fl.drive': { kind: 'external', canId: 3, note: 'SPARK' } })).toEqual([]);

    const plane = tpl('air.plane');
    const base = { motor: { kind: 'device', uid48: 'm', model: 'esc20a' }, 'ail.l': { kind: 'channel', uid48: 's', model: 'servo16', channel: 1 }, 'ail.r': { kind: 'channel', uid48: 's', model: 'servo16', channel: 2 }, elev: { kind: 'channel', uid48: 's', model: 'servo16', channel: 3 }, gyro: { kind: 'device', uid48: 'g', model: 'gyro' } } as const;
    expect(codes({ ...base }, plane)).toEqual([]);
    expect(codes({ ...base, 'ail.r': { kind: 'channel', uid48: 'S', model: 'servo16', channel: 1 } }, plane)).toContain('duplicateChannel');
    expect(codes({ ...base, elev: { kind: 'channel', uid48: 's', model: 'servo16', channel: 17 } }, plane)).toContain('invalidChannel');
  });
});

describe('planApply', () => {
  it('shifts numbers that collide with boards outside the template', () => {
    const t = tpl('frc.mecanum4');
    const bindings: VehicleConfig['bindings'] = {};
    const devices: PlanDevice[] = [];
    t.slots.filter((s) => s.role === 'drive').forEach((s, i) => {
      bindings[s.id] = { kind: 'device', uid48: `d${i}`, model: 'esc20a' };
      devices.push(dev(`d${i}`, 'esc20a', ESC, 63));
    });
    devices.push(dev('other', 'esc80a', ESC, 2), dev('enc', 'cyncoder', ENC, 1));
    const { steps, warnings } = planApply(t, { templateId: t.id, name: 'v', bindings }, devices);
    const nums = steps.filter((s) => s.kind === 'assignNum').map((s) => (s.kind === 'assignNum' ? s.to : 0));
    expect(nums).toEqual([1, 3, 4, 5]);
    expect(warnings.filter((w) => w.code === 'numShifted')).toHaveLength(3);
  });

  it('skips unchanged name, number and known param values', () => {
    const t = tpl('ground.skid4');
    const d: PlanDevice = { uid48: 'aa', model: 'esc20a', devType: ESC, num: 1, name: 'Ön sol · sürüş', params: { 'motor.idle_mode': 0 } };
    const { steps } = planApply(t, { templateId: t.id, name: 'v', bindings: { 'fl.drive': { kind: 'device', uid48: 'AA', model: 'esc20a' } } }, [d]);
    expect(steps).toEqual([]);
  });

  it('shortens names to 21 UTF-8 bytes on a character boundary', () => {
    const base = tpl('frc.swerve4');
    const t = { ...base, slots: base.slots.map((s) => (s.id === 'bl.enc' ? { ...s, label: { tr: 'Çok uzun şaşırtıcı yuva adı', en: 'A very long slot label here' } } : s)) };
    const cfg: VehicleConfig = { templateId: t.id, name: 'v', bindings: { 'bl.enc': { kind: 'device', uid48: 'aa', model: 'cyncoder' } } };
    const d = dev('aa', 'cyncoder', ENC, 9);
    const { steps, warnings } = planApply(t, cfg, [d]);
    const rename = steps.find((s) => s.kind === 'rename');
    if (rename?.kind !== 'rename') throw new Error('no rename');
    expect(new TextEncoder().encode(rename.to).length).toBeLessThanOrEqual(21);
    expect(rename.to).toBe('Çok uzun şaşırtı');
    expect(warnings.some((w) => w.code === 'nameShortened')).toBe(true);
    const en = planApply(t, cfg, [d], 'en').steps.find((s) => s.kind === 'rename');
    expect(en).toMatchObject({ to: 'A very long slot label' .slice(0, 21).trim() });
    const fit = planApply(base, { templateId: base.id, name: 'v', bindings: { 'br.enc': { kind: 'device', uid48: 'aa', model: 'cyncoder' } } }, [d], 'en');
    expect(fit.warnings).toEqual([]);
  });

  it('writes channel params to the servo board and shares one number', () => {
    const t = tpl('air.plane');
    const bindings: VehicleConfig['bindings'] = {
      'ail.l': { kind: 'channel', uid48: 's', model: 'servo16', channel: 3 },
      'ail.r': { kind: 'channel', uid48: 's', model: 'servo16', channel: 4 },
    };
    const { steps } = planApply(t, { templateId: t.id, name: 'v', bindings }, [dev('s', 'servo16', SERVO, 0)]);
    expect(steps.filter((s) => s.kind === 'assignNum')).toHaveLength(1);
    expect(steps).toContainEqual({ kind: 'setParam', uid48: 's', slotId: 'ail.l', key: 'ch.3.enable', value: 1, channel: 3 });
    expect(steps).toContainEqual({ kind: 'setParam', uid48: 's', slotId: 'ail.r', key: 'ch.4.failsafe_us', value: 1500, channel: 4 });
    expect(steps.filter((s) => s.kind === 'rename')).toMatchObject([{ to: 'Servo kartı' }]);
  });

  it('points swerve steer motors at the module encoder', () => {
    const t = tpl('frc.swerve4');
    const bindings: VehicleConfig['bindings'] = {
      'fr.steer': { kind: 'device', uid48: 'st', model: 'esc20a' },
      'fr.enc': { kind: 'device', uid48: 'en', model: 'cyncoder' },
    };
    const { steps, warnings } = planApply(t, { templateId: t.id, name: 'v', bindings }, [dev('st', 'esc20a', ESC, 0), dev('en', 'cyncoder', ENC, 0), dev('g', 'gyro', GYRO, 5)]);
    expect(steps).toContainEqual(expect.objectContaining({ kind: 'setParam', key: 'fb.source', value: 2 }));
    expect(steps).toContainEqual(expect.objectContaining({ kind: 'setParam', key: 'fb.remote_num', value: 2 }));
    expect(warnings).toEqual([]);
    const lone = planApply(t, { templateId: t.id, name: 'v', bindings: { 'fr.steer': bindings['fr.steer'] as never } }, [dev('st', 'esc20a', ESC, 0)]);
    expect(lone.warnings.map((w) => w.code)).toContain('noRemoteEncoder');
  });

  it('warns about boards missing from the bus', () => {
    const t = tpl('frc.mecanum4');
    const r = planApply(t, { templateId: t.id, name: 'v', bindings: { 'fl.drive': { kind: 'device', uid48: 'zz', model: 'esc20a' } } }, []);
    expect(r.steps).toEqual([]);
    expect(r.warnings[0]?.code).toBe('deviceNotFound');
  });
});
