import { DevType, Model } from '../../core/constants';
import { opts, pBool, pEnum, pF32, sig, tx } from '../builders';
import { defineModel } from '../common';
import type { ModelDef, Text } from '../schema';

const fuseBits = (n: number): Text[] =>
  Array.from({ length: n }, (_, i) => tx([`Kanal ${i + 1} sigortası`, `Channel ${i + 1} fuse`]));

const UV_WARN_HELP = [
  'Giriş gerilimi bu değerin altına inerse düşük gerilim uyarısı verilir.',
  'An undervoltage warning is raised when the input drops below this value.',
] as const;

// Small power distribution: placeholder until the hardware (and its CAN support) is fixed.
export const POWER_DIST_SMALL: ModelDef = defineModel({
  model: Model.POWER_DIST_SMALL,
  devType: DevType.POWER_DISTRIBUTION,
  key: 'pdh_small',
  name: tx(['Güç dağıtım, küçük', 'Power distribution, small']),
  category: 'power',
  catalogRev: 1,
  description: tx([
    '4 çıkışlı küçük güç dağıtım kartı (yer tutucu katalog).',
    'Small 4-output power distribution board (placeholder catalog).',
  ]),
  common: { actuator: false, termination: 'fixed' },
  groups: [{ key: 'power', label: tx(['Güç', 'Power']) }],
  params: [
    pF32(0x0100, 'power.uv_warn_v', 'power', ['Düşük gerilim uyarı eşiği', 'Undervoltage warning threshold'], UV_WARN_HELP,
      { unit: 'V', min: 5, max: 30, step: 0.1, def: 10.5 }),
  ],
  signals: [
    sig(1, 'input.voltage', 'V', ['Giriş gerilimi', 'Input voltage'], [0, 16], 2),
    sig(2, 'total.current', 'A', ['Toplam akım', 'Total current'], [0, 60], 2),
    sig(3, 'rail5.voltage', 'V', ['5 V ray gerilimi', '5 V rail voltage'], [0, 6], 2),
    sig(4, 'rail12.voltage', 'V', ['12 V ray gerilimi', '12 V rail voltage'], [0, 14], 2),
    sig(5, 'fuse.mask', '', ['Atan sigortalar', 'Blown fuses'], [0, 15], 0, { bits: fuseBits(4) }),
  ],
  statusFrames: [
    {
      index: 0,
      label: tx(['Güç', 'Power']),
      defaultPeriodMs: 100,
      fields: [
        { signal: 'input.voltage', byte: 0, type: 'u16', scale: 0.01 },
        { signal: 'total.current', byte: 2, type: 'u16', scale: 0.01 },
        { signal: 'rail5.voltage', byte: 4, type: 'u16', scale: 0.001 },
        { signal: 'rail12.voltage', byte: 6, type: 'u16', scale: 0.001 },
      ],
    },
    {
      index: 1,
      label: tx(['Sigortalar', 'Fuses']),
      defaultPeriodMs: 500,
      fields: [{ signal: 'fuse.mask', byte: 0, type: 'u8', bit: 0, bits: 4 }],
    },
  ],
  controls: [],
  actions: [],
  faults: [{ bit: 10, key: 'fuse_blown', label: tx(['Sigorta attı', 'Fuse blown']) }],
  selfTestBits: [
    { bit: 0, key: 'current_sense', label: tx(['Akım ölçümü', 'Current sensing']) },
    { bit: 1, key: 'rail_sense', label: tx(['Ray gerilimleri', 'Rail voltages']) },
  ],
  stream: { minPeriodUs: 2000 },
  tuner: { loops: [] },
});

const PDH_CHANNELS = 8;

export const POWER_DIST_LARGE: ModelDef = defineModel({
  model: Model.POWER_DIST_LARGE,
  devType: DevType.POWER_DISTRIBUTION,
  key: 'pdh_large',
  name: tx(['Güç dağıtım, büyük', 'Power distribution, large']),
  category: 'power',
  catalogRev: 1,
  description: tx([
    '8 sigortalı güç kanalı, 5 V ve 12 V yardımcı çıkış; kanal başına akım ölçümü.',
    '8 fused power channels plus 5 V and 12 V auxiliary outputs, with per-channel current sensing.',
  ]),
  common: { actuator: false, termination: 'switchable' },
  groups: [
    { key: 'power', label: tx(['Güç', 'Power']) },
    { key: 'channels', label: tx(['Kanallar', 'Channels']) },
    { key: 'aux', label: tx(['Yardımcı çıkışlar', 'Auxiliary outputs']) },
  ],
  params: [
    pF32(0x0100, 'power.uv_warn_v', 'power', ['Düşük gerilim uyarı eşiği', 'Undervoltage warning threshold'], UV_WARN_HELP,
      { unit: 'V', min: 5, max: 30, step: 0.1, def: 10.5 }),
    pF32(0x0101, 'power.total_warn_a', 'power', ['Toplam akım uyarı eşiği', 'Total current warning threshold'],
      ['Toplam akım bu değeri aşarsa uyarı verilir; ana sigortanın altında tutun.', 'A warning is raised when total current exceeds this value; keep it below the main breaker.'],
      { unit: 'A', min: 1, max: 300, step: 1, def: 120 }),
    ...Array.from({ length: PDH_CHANNELS }, (_, i) =>
      pF32(0x0110 + i, `ch.${i + 1}.warn_a`, 'channels', [`Kanal ${i + 1} · Uyarı akımı`, `Channel ${i + 1} · Warning current`],
        ['Kanal akımı bu değeri aşarsa uyarı verilir; 0 uyarıyı kapatır.', 'A warning is raised when the channel current exceeds this value; 0 disables it.'],
        { unit: 'A', min: 0, max: 40, step: 0.5, def: 30 }),
    ),
    pBool(0x0120, 'aux.5v_enable', 'aux', ['5 V yardımcı çıkış etkin', '5 V auxiliary output enabled'],
      ['5 V · 1 A yardımcı çıkışı açar veya kapatır.', 'Turns the 5 V · 1 A auxiliary output on or off.'], true),
    pBool(0x0121, 'aux.12v_enable', 'aux', ['12 V yardımcı çıkış etkin', '12 V auxiliary output enabled'],
      ['12 V · 1 A yardımcı çıkışı açar veya kapatır.', 'Turns the 12 V · 1 A auxiliary output on or off.'], true),
  ],
  signals: [
    sig(1, 'input.voltage', 'V', ['Giriş gerilimi', 'Input voltage'], [0, 16], 2),
    sig(2, 'total.current', 'A', ['Toplam akım', 'Total current'], [0, 200], 1),
    ...Array.from({ length: PDH_CHANNELS }, (_, i) =>
      sig(3 + i, `ch.${i + 1}.current`, 'A', [`Kanal ${i + 1} akımı`, `Channel ${i + 1} current`], [0, 40], 2),
    ),
    sig(11, 'fuse.mask', '', ['Atan sigortalar', 'Blown fuses'], [0, 255], 0, { bits: fuseBits(PDH_CHANNELS) }),
    sig(12, 'aux5.voltage', 'V', ['5 V ray gerilimi', '5 V rail voltage'], [0, 6], 3),
    sig(13, 'aux5.current', 'A', ['5 V ray akımı', '5 V rail current'], [0, 1.5], 3),
    sig(14, 'aux12.voltage', 'V', ['12 V ray gerilimi', '12 V rail voltage'], [0, 14], 3),
    sig(15, 'aux12.current', 'A', ['12 V ray akımı', '12 V rail current'], [0, 1.5], 3),
    sig(16, 'temp', '°C', ['Kart sıcaklığı', 'Board temperature'], [0, 100], 0),
    sig(17, 'energy', 'Wh', ['Harcanan enerji', 'Energy used'], [0, 200], 2),
    sig(18, 'power', 'W', ['Anlık güç', 'Power'], [0, 2500], 0),
  ],
  statusFrames: [
    {
      index: 0,
      label: tx(['Kanal 1–4 akımı', 'Channel 1–4 current']),
      defaultPeriodMs: 50,
      fields: [0, 1, 2, 3].map((i) => ({ signal: `ch.${i + 1}.current`, byte: 2 * i, type: 'u16' as const, scale: 0.01 })),
    },
    {
      index: 1,
      label: tx(['Kanal 5–8 akımı', 'Channel 5–8 current']),
      defaultPeriodMs: 50,
      fields: [0, 1, 2, 3].map((i) => ({ signal: `ch.${i + 5}.current`, byte: 2 * i, type: 'u16' as const, scale: 0.01 })),
    },
    {
      index: 2,
      label: tx(['Toplam', 'Totals']),
      defaultPeriodMs: 100,
      fields: [
        { signal: 'input.voltage', byte: 0, type: 'u16', scale: 0.01 },
        { signal: 'total.current', byte: 2, type: 'u16', scale: 0.01 },
        { signal: 'power', byte: 4, type: 'u16' },
        { signal: 'fuse.mask', byte: 6, type: 'u8' },
        { signal: 'temp', byte: 7, type: 'i8' },
      ],
    },
    {
      index: 3,
      label: tx(['Yardımcı raylar', 'Auxiliary rails']),
      defaultPeriodMs: 500,
      fields: [
        { signal: 'aux5.voltage', byte: 0, type: 'u16', scale: 0.001 },
        { signal: 'aux5.current', byte: 2, type: 'u16', scale: 0.001 },
        { signal: 'aux12.voltage', byte: 4, type: 'u16', scale: 0.001 },
        { signal: 'aux12.current', byte: 6, type: 'u16', scale: 0.001 },
      ],
    },
    {
      index: 4,
      label: tx(['Enerji', 'Energy']),
      defaultPeriodMs: 1000,
      fields: [{ signal: 'energy', byte: 0, type: 'f32' }],
    },
  ],
  controls: [],
  actions: [
    { cmd: 0x40, key: 'reset_energy', label: tx(['Enerji sayacını sıfırla', 'Reset energy counter']),
      help: tx(['Harcanan enerji sayacını sıfırlar.', 'Resets the energy-used counter to zero.']) },
  ],
  faults: [
    { bit: 10, key: 'fuse_blown', label: tx(['Sigorta attı', 'Fuse blown']) },
    { bit: 11, key: 'aux_overcurrent', label: tx(['Yardımcı ray aşırı akım', 'Auxiliary rail overcurrent']) },
  ],
  selfTestBits: [
    { bit: 0, key: 'current_sense', label: tx(['Akım sensörleri', 'Current sensors']) },
    { bit: 1, key: 'rail_sense', label: tx(['Ray gerilimleri', 'Rail voltages']) },
    { bit: 2, key: 'fuse_sense', label: tx(['Sigorta algılama', 'Fuse detection']) },
  ],
  stream: { minPeriodUs: 1000 },
  tuner: { loops: [] },
});

export const SOC_REGULATOR: ModelDef = defineModel({
  model: Model.SOC_REGULATOR,
  devType: DevType.POWER_DISTRIBUTION,
  key: 'soc_reg',
  name: tx(['SoC regülatörü', 'SoC regulator']),
  category: 'power',
  catalogRev: 1,
  description: tx([
    'Yardımcı bilgisayarlar (SoC) için kararlı besleme; 5, 12 veya 19 V çıkışlı varyantlar.',
    'Stable supply for coprocessors (SoC); variants with 5, 12 or 19 V output.',
  ]),
  common: { actuator: false, termination: 'fixed' },
  groups: [{ key: 'power', label: tx(['Güç', 'Power']) }],
  params: [
    pEnum(0x0100, 'reg.output_v', 'power', ['Çıkış gerilimi', 'Output voltage'],
      ['Kartın donanım varyantıyla belirlenen çıkış gerilimi.', 'Output voltage fixed by the board’s hardware variant.'],
      opts([5, '5 V', '5 V'], [12, '12 V', '12 V'], [19, '19 V', '19 V']), 12, { readOnly: true }),
    pF32(0x0101, 'reg.uvlo_v', 'power', ['Düşük giriş gerilimi kesme', 'Input undervoltage cutoff'],
      ['Giriş bu gerilimin altına inerse çıkış kapatılır.', 'The output is switched off when the input drops below this voltage.'],
      { unit: 'V', min: 5, max: 30, step: 0.1, def: 6.5 }),
    pF32(0x0102, 'reg.current_warn_a', 'power', ['Çıkış akımı uyarı eşiği', 'Output current warning threshold'],
      ['Çıkış akımı bu değeri aşarsa uyarı verilir.', 'A warning is raised when the output current exceeds this value.'],
      { unit: 'A', min: 0.1, max: 10, step: 0.1, def: 4 }),
  ],
  signals: [
    sig(1, 'input.voltage', 'V', ['Giriş gerilimi', 'Input voltage'], [0, 16], 2),
    sig(2, 'output.voltage', 'V', ['Çıkış gerilimi', 'Output voltage'], [0, 20], 3),
    sig(3, 'output.current', 'A', ['Çıkış akımı', 'Output current'], [0, 6], 3),
    sig(4, 'output.ripple', 'mV', ['Çıkış dalgalanması (tepe-tepe)', 'Output ripple (peak-to-peak)'], [0, 200], 1),
    sig(5, 'temp', '°C', ['Sıcaklık', 'Temperature'], [0, 100], 1),
    sig(6, 'brownout.count', '', ['Gerilim düşmesi sayacı', 'Brownout counter'], [0, 100], 0),
  ],
  statusFrames: [
    {
      index: 0,
      label: tx(['Güç', 'Power']),
      defaultPeriodMs: 50,
      fields: [
        { signal: 'input.voltage', byte: 0, type: 'u16', scale: 0.01 },
        { signal: 'output.voltage', byte: 2, type: 'u16', scale: 0.001 },
        { signal: 'output.current', byte: 4, type: 'u16', scale: 0.001 },
        { signal: 'output.ripple', byte: 6, type: 'u16', scale: 0.1 },
      ],
    },
    {
      index: 1,
      label: tx(['Isıl ve sayaç', 'Thermal and counter']),
      defaultPeriodMs: 1000,
      fields: [
        { signal: 'temp', byte: 0, type: 'i16', scale: 0.1 },
        { signal: 'brownout.count', byte: 2, type: 'u32' },
      ],
    },
  ],
  controls: [],
  actions: [],
  faults: [
    { bit: 10, key: 'output_overcurrent', label: tx(['Çıkış aşırı akım', 'Output overcurrent']) },
    { bit: 11, key: 'output_out_of_regulation', label: tx(['Çıkış düzensiz', 'Output out of regulation']) },
  ],
  selfTestBits: [
    { bit: 0, key: 'output_sense', label: tx(['Çıkış gerilimi ölçümü', 'Output voltage sensing']) },
    { bit: 1, key: 'current_sense', label: tx(['Akım ölçümü', 'Current sensing']) },
  ],
  stream: { minPeriodUs: 1000 },
  tuner: { loops: [] },
});
