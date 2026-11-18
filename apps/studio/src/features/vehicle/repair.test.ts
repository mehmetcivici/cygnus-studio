import { describe, expect, it } from 'vitest';
import { getTemplate, type VehicleConfig } from '@cygnus/vehicles';
import { repairVehicleConfig, sanitizeBinding, slotStatuses } from './model';

const tpl = getTemplate('frc.swerve4')!;
const slotIds = new Set(tpl.slots.map((s) => s.id));
const withBindings = (bindings: unknown): VehicleConfig => ({ templateId: 'frc.swerve4', name: 'bad', bindings: bindings as VehicleConfig['bindings'] });

describe('repairVehicleConfig (corrupt project files, uygulama #8)', () => {
  it.each([
    ['null', null],
    ['string', 'x'],
    ['no kind, numeric uid', { uid48: 123 }],
    ['bad uid', { kind: 'device', uid48: 'zz', model: 'esc80a' }],
    ['channel out of range', { kind: 'channel', uid48: '0123456789ab', model: 'servo16', channel: 99 }],
  ])('drops %s bindings and the result renders', (_name, value) => {
    const bindings = Object.fromEntries(tpl.slots.map((s) => [s.id, value]));
    const { config, dropped } = repairVehicleConfig(withBindings(bindings), slotIds);
    expect(dropped).toHaveLength(tpl.slots.length);
    expect(config.bindings).toEqual({});
    expect(() => slotStatuses(tpl, config.bindings, [])).not.toThrow();
  });

  it('survives a non-object bindings field', () => {
    expect(repairVehicleConfig(withBindings(null), slotIds).config.bindings).toEqual({});
    expect(repairVehicleConfig(withBindings([1, 2]), slotIds).config.bindings).toEqual({});
  });

  it('keeps good bindings, normalises case, drops unknown slots, and returns the same object when clean', () => {
    const good = withBindings({ 'fl.drive': { kind: 'device', uid48: '0123456789ab', model: 'esc80a' } });
    expect(repairVehicleConfig(good, slotIds).config).toBe(good);
    const mixed = withBindings({ 'fl.drive': { kind: 'device', uid48: '0123456789AB', model: 'esc80a' }, ghost: { kind: 'external', note: '' } });
    const r = repairVehicleConfig(mixed, slotIds);
    expect(r.dropped).toEqual(['ghost']);
    expect(r.config.bindings['fl.drive']).toEqual({ kind: 'device', uid48: '0123456789ab', model: 'esc80a' });
  });

  it('accepts external bindings with or without a CAN id', () => {
    expect(sanitizeBinding({ kind: 'external', note: 'roboRIO PWM 0' })).toEqual({ kind: 'external', note: 'roboRIO PWM 0' });
    expect(sanitizeBinding({ kind: 'external', canId: 5, note: 3 })).toEqual({ kind: 'external', canId: 5, note: '' });
  });
});
