import { DevType, Model } from '../../core/constants';
import { pBool, pF32, pU32, sig, tx } from '../builders';
import { defineModel } from '../common';
import type { ControlFrameDef, ModelDef, ParamDef, SignalDef, StatusFrameDef } from '../schema';

export const SERVO16_CHANNELS = 16;

/** Per-channel parameters live at 0x0200 + (channel − 1) · 0x10 + field. */
export function servo16ChannelPid(channel: number, field: number): number {
  return 0x0200 + (channel - 1) * 0x10 + field;
}

function channelParams(ch: number): ParamDef[] {
  const pid = (f: number) => servo16ChannelPid(ch, f);
  const g = 'channels';
  const k = `ch.${ch}`;
  const L = (tr: string, en: string) => [`Kanal ${ch} · ${tr}`, `Channel ${ch} · ${en}`] as const;
  return [
    pBool(pid(0), `${k}.enable`, g, L('Etkin', 'Enabled'),
      ['Kapalı kanal darbe üretmez.', 'A disabled channel outputs no pulses.'], true),
    pU32(pid(1), `${k}.min_us`, g, L('En küçük darbe', 'Minimum pulse'),
      ['Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur.', 'Shortest pulse the output may reach; protects the servo’s mechanical end.'],
      { unit: 'µs', min: 400, max: 2600, def: 1000 }),
    pU32(pid(2), `${k}.center_us`, g, L('Orta darbe', 'Center pulse'),
      ['"Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta.', 'Midpoint used by "Center all channels" and for inversion.'],
      { unit: 'µs', min: 400, max: 2600, def: 1500 }),
    pU32(pid(3), `${k}.max_us`, g, L('En büyük darbe', 'Maximum pulse'),
      ['Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur.', 'Longest pulse the output may reach; protects the servo’s mechanical end.'],
      { unit: 'µs', min: 400, max: 2600, def: 2000 }),
    pU32(pid(4), `${k}.failsafe_us`, g, L('Güvenli darbe', 'Failsafe pulse'),
      ['Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır.', 'Pulse applied on command timeout; 0 turns the output off.'],
      { unit: 'µs', min: 0, max: 2600, def: 0, minNonZero: 400 }),
    pBool(pid(5), `${k}.invert`, g, L('Ters çevir', 'Invert'),
      ['Komutu orta darbeye göre aynalar.', 'Mirrors the command around the center pulse.'], false),
    pU32(pid(6), `${k}.speed_us_s`, g, L('Hız sınırı', 'Speed limit'),
      ['Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız.', 'Largest pulse change per second; 0 means unlimited.'],
      { unit: 'µs/s', min: 0, max: 100000, step: 10, def: 0, advanced: true }),
  ];
}

const channelSignals: SignalDef[] = Array.from({ length: SERVO16_CHANNELS }, (_, i) =>
  sig(3 + i, `ch.${i + 1}.pulse`, 'µs', [`Kanal ${i + 1} darbesi`, `Channel ${i + 1} pulse`], [500, 2500], 0),
);

const channelFrames: StatusFrameDef[] = Array.from({ length: 4 }, (_, f) => ({
  index: 1 + f,
  label: tx([`Kanal ${4 * f + 1}–${4 * f + 4}`, `Channels ${4 * f + 1}–${4 * f + 4}`]),
  defaultPeriodMs: 100,
  fields: Array.from({ length: 4 }, (_, i) => ({ signal: `ch.${4 * f + i + 1}.pulse`, byte: 2 * i, type: 'u16' as const })),
}));

const controlFrames: ControlFrameDef[] = Array.from({ length: 4 }, (_, f) => ({
  index: f,
  key: `channels_${4 * f + 1}_${4 * f + 4}`,
  label: tx([`Kanal ${4 * f + 1}–${4 * f + 4} darbeleri`, `Channel ${4 * f + 1}–${4 * f + 4} pulses`]),
  format: 'servo4' as const,
  firstChannel: 4 * f + 1,
}));

export const SERVO16: ModelDef = defineModel({
  model: Model.SERVO_16CH,
  devType: DevType.SERVO_CONTROLLER,
  key: 'servo16',
  name: tx(['CAN servo kontrol, 16 kanal', 'CAN servo controller, 16 channels']),
  category: 'servo',
  catalogRev: 1,
  description: tx([
    '16 kanallı servo darbe üreteci; kanal başına sınırlar, güvenli konum ve hız sınırı.',
    '16-channel servo pulse generator with per-channel limits, failsafe pulse and slew limit.',
  ]),
  common: { actuator: true, termination: 'fixed' },
  groups: [
    { key: 'servo', label: tx(['Genel', 'General']) },
    { key: 'channels', label: tx(['Kanallar', 'Channels']) },
  ],
  params: [
    pU32(0x0100, 'servo.pwm_hz', 'servo', ['PWM frekansı', 'PWM frequency'],
      ['Tüm kanalların darbe tekrarlama frekansı; analog servolar için 50 Hz kullanın.', 'Pulse repetition rate for all channels; use 50 Hz for analog servos.'],
      { unit: 'Hz', min: 50, max: 333, def: 50, lockedWhileEnabled: true }),
    pF32(0x0101, 'servo.rail_uv_warn_v', 'servo', ['Servo rayı düşük gerilim uyarısı', 'Servo rail undervoltage warning'],
      ['Servo besleme rayı bu gerilimin altına inerse uyarı verilir.', 'A warning is raised when the servo supply rail drops below this voltage.'],
      { unit: 'V', min: 3, max: 12, step: 0.1, def: 4.5 }),
    ...Array.from({ length: SERVO16_CHANNELS }, (_, i) => channelParams(i + 1)).flat(),
  ],
  signals: [
    sig(1, 'rail.voltage', 'V', ['Servo rayı gerilimi', 'Servo rail voltage'], [0, 12], 2),
    sig(2, 'rail.current', 'A', ['Toplam akım', 'Total current'], [0, 20], 2),
    ...channelSignals,
    sig(19, 'temp', '°C', ['Kart sıcaklığı', 'Board temperature'], [0, 100], 1),
  ],
  statusFrames: [
    {
      index: 0,
      label: tx(['Güç', 'Power']),
      defaultPeriodMs: 50,
      fields: [
        { signal: 'rail.voltage', byte: 0, type: 'u16', scale: 0.001 },
        { signal: 'rail.current', byte: 2, type: 'u16', scale: 0.001 },
        { signal: 'temp', byte: 4, type: 'i16', scale: 0.1 },
      ],
    },
    ...channelFrames,
  ],
  controls: controlFrames,
  actions: [
    { cmd: 0x40, key: 'center_all', label: tx(['Tüm kanalları ortala', 'Center all channels']),
      help: tx(['Etkin kanalların hepsini orta darbeye getirir.', 'Moves every enabled channel to its center pulse.']), confirm: true, movesActuator: true },
    { cmd: 0x41, key: 'disable_all', label: tx(['Tüm kanalları kapat', 'Disable all channels']),
      help: tx(['Bütün kanallarda darbe üretimini durdurur.', 'Stops pulse output on every channel.']) },
  ],
  faults: [{ bit: 10, key: 'rail_overcurrent', label: tx(['Servo rayı aşırı akım', 'Servo rail overcurrent']) }],
  selfTestBits: [
    { bit: 0, key: 'pwm_driver', label: tx(['PWM üreteci', 'PWM generator']) },
    { bit: 1, key: 'rail_sense', label: tx(['Ray gerilimi ölçümü', 'Rail voltage sensing']) },
    { bit: 2, key: 'current_sense', label: tx(['Akım ölçümü', 'Current sensing']) },
    { bit: 3, key: 'param_storage', label: tx(['Ayar belleği', 'Settings memory']) },
  ],
  stream: { minPeriodUs: 1000 },
  tuner: { loops: [] },
});
