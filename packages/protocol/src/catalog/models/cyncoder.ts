import { DevType, Model } from '../../core/constants';
import { opts, pBool, pEnum, pF32, pU32, sig, tx } from '../builders';
import { defineModel } from '../common';
import type { ModelDef } from '../schema';

export const MagnetStatus = { OK: 0, WEAK: 1, STRONG: 2, MISSING: 3 } as const;

export const CYNCODER: ModelDef = defineModel({
  model: Model.CYNCODER,
  devType: DevType.ENCODER,
  key: 'cyncoder',
  name: tx(['Cyncoder', 'Cyncoder']),
  category: 'sensor',
  catalogRev: 1,
  description: tx([
    'Manyetik mutlak kodlayıcı; mutlak ve çok turlu konum, hız ve mıknatıs durumu bildirir.',
    'Magnetic absolute encoder; reports absolute and multi-turn position, velocity and magnet health.',
  ]),
  common: { actuator: false, termination: 'fixed' },
  groups: [
    { key: 'encoder', label: tx(['Kodlayıcı', 'Encoder']) },
    { key: 'magnet', label: tx(['Mıknatıs ve sensör', 'Magnet and sensor']) },
  ],
  params: [
    pF32(0x0100, 'enc.zero_offset_rot', 'encoder', ['Sıfır ofseti', 'Zero offset'],
      ['Ham mutlak açıdan çıkarılan değer; "Buradan sıfırla" eylemi doldurur.', 'Value subtracted from the raw absolute angle; filled by "Zero here".'],
      { unit: 'rot', min: 0, max: 1, step: 0.0001, def: 0 }),
    pBool(0x0101, 'enc.invert', 'encoder', ['Yönü ters çevir', 'Invert direction'],
      ['Saat yönünde dönüşün pozitif sayılmasını sağlar.', 'Makes clockwise rotation count as positive.'],
      false),
    pEnum(0x0102, 'enc.abs_range', 'encoder', ['Mutlak aralık', 'Absolute range'],
      ['Mutlak konumun 0..1 tur mu yoksa −0,5..+0,5 tur mu bildirileceği.', 'Whether the absolute position is reported as 0..1 or −0.5..+0.5 turns.'],
      opts([0, '0 … 1 tur', '0 … 1 turn'], [1, '−0,5 … +0,5 tur', '−0.5 … +0.5 turn']), 0),
    pF32(0x0103, 'enc.ratio', 'encoder', ['Sensör:mekanizma oranı', 'Sensor:mechanism ratio'],
      ['Sensörün bir mekanizma turu için attığı tur; çok turlu konum ve hız mekanizma turu olarak verilir.', 'Sensor turns per mechanism turn; multi-turn position and velocity are given in mechanism turns.'],
      { min: 0.001, max: 1000, step: 0.001, def: 1 }),
    pU32(0x0104, 'enc.vel_window_ms', 'encoder', ['Hız filtresi penceresi', 'Velocity filter window'],
      ['Hızın hesaplandığı zaman penceresi; uzun pencere daha düzgün ama daha gecikmeli sonuç verir.', 'Time window used to compute velocity; longer is smoother but adds lag.'],
      { unit: 'ms', min: 1, max: 100, def: 10 }),
    pEnum(0x0105, 'enc.boot_position', 'encoder', ['Açılışta konum', 'Position at boot'],
      ['Açılışta çok turlu konumun mutlak açıdan mı başlayacağı yoksa sıfırdan mı.', 'Whether the multi-turn position starts from the absolute angle or from zero at boot.'],
      opts([0, 'Mutlak açıdan', 'From absolute angle'], [1, 'Sıfırdan', 'From zero']), 0),
    pEnum(0x0120, 'mag.hysteresis', 'magnet', ['Açı histerezisi', 'Angle hysteresis'],
      ['Duran mıknatısta çıkışın titremesini önleyen histerezis (en düşük anlamlı bit).', 'Hysteresis that stops the output from flickering with a still magnet (LSBs).'],
      opts([0, 'Kapalı', 'Off'], [1, '1 LSB', '1 LSB'], [2, '2 LSB', '2 LSB'], [3, '3 LSB', '3 LSB']), 0, { advanced: true }),
    pEnum(0x0121, 'mag.slow_filter', 'magnet', ['Sensör yavaş filtresi', 'Sensor slow filter'],
      ['Sensör içindeki ortalama filtresi; yüksek değer daha az gürültü, daha fazla gecikme.', 'Averaging filter inside the sensor; higher means less noise and more lag.'],
      opts([0, '16×', '16×'], [1, '8×', '8×'], [2, '4×', '4×'], [3, '2×', '2×']), 2, { advanced: true }),
    pU32(0x0122, 'mag.fast_threshold', 'magnet', ['Hızlı filtre eşiği', 'Fast filter threshold'],
      ['Hızlı dönüşte yavaş filtrenin devreden çıkacağı eşik; 0 hızlı filtreyi kapatır.', 'Threshold at which the slow filter is bypassed during fast motion; 0 disables the fast filter.'],
      { min: 0, max: 7, def: 0, advanced: true }),
    pU32(0x0123, 'mag.agc_strong', 'magnet', ['"Çok güçlü" eşiği (AGC)', '"Too strong" threshold (AGC)'],
      ['Kazanç (AGC) bu değerin altına inerse mıknatıs çok yakın sayılır.', 'Gain (AGC) below this value means the magnet is too close.'],
      { min: 0, max: 255, def: 20, advanced: true }),
    pU32(0x0124, 'mag.agc_weak', 'magnet', ['"Zayıf" eşiği (AGC)', '"Weak" threshold (AGC)'],
      ['Kazanç (AGC) bu değerin üstüne çıkarsa mıknatıs zayıf veya uzak sayılır.', 'Gain (AGC) above this value means the magnet is weak or too far.'],
      { min: 0, max: 255, def: 220, advanced: true }),
  ],
  signals: [
    sig(1, 'abs.position', 'rot', ['Mutlak konum', 'Absolute position'], [-0.5, 1], 4),
    sig(2, 'position', 'rot', ['Çok turlu konum', 'Multi-turn position'], [-10, 10], 4),
    sig(3, 'velocity', 'rpm', ['Hız', 'Velocity'], [-6000, 6000], 1),
    sig(4, 'magnet.agc', '', ['Mıknatıs alan şiddeti (AGC)', 'Magnet field strength (AGC)'], [0, 255], 0),
    sig(5, 'magnet.status', '', ['Mıknatıs durumu', 'Magnet status'], [0, 3], 0, {
      options: opts([MagnetStatus.OK, 'İyi', 'Good'], [MagnetStatus.WEAK, 'Zayıf', 'Weak'], [MagnetStatus.STRONG, 'Çok güçlü', 'Too strong'], [MagnetStatus.MISSING, 'Yok', 'Missing']),
    }),
    sig(6, 'raw.angle', '', ['Ham açı', 'Raw angle'], [0, 4095], 0),
    sig(7, 'temp', '°C', ['Kart sıcaklığı', 'Board temperature'], [0, 100], 0),
  ],
  statusFrames: [
    {
      index: 0,
      label: tx(['Konum ve hız', 'Position and velocity']),
      defaultPeriodMs: 10,
      fields: [
        { signal: 'position', byte: 0, type: 'f32' },
        { signal: 'velocity', byte: 4, type: 'f32' },
      ],
    },
    {
      index: 1,
      label: tx(['Mutlak ve mıknatıs', 'Absolute and magnet']),
      defaultPeriodMs: 20,
      fields: [
        { signal: 'abs.position', byte: 0, type: 'f32' },
        { signal: 'raw.angle', byte: 4, type: 'u16', bit: 0, bits: 12 },
        { signal: 'magnet.status', byte: 4, type: 'u16', bit: 12, bits: 2 },
        { signal: 'magnet.agc', byte: 6, type: 'u8' },
        { signal: 'temp', byte: 7, type: 'i8' },
      ],
    },
  ],
  controls: [],
  actions: [
    { cmd: 0x40, key: 'zero_here', label: tx(['Buradan sıfırla', 'Zero here']),
      help: tx(['Şu anki mutlak açıyı sıfır ofseti olarak yazar; kalıcı olması için kaydedin.', 'Stores the current absolute angle as the zero offset; save to make it permanent.']) },
    { cmd: 0x41, key: 'reset_turns', label: tx(['Çok turlu sayacı sıfırla', 'Reset turn counter']),
      help: tx(['Çok turlu konumu mutlak açıya geri çeker; tur sayısı sıfırlanır.', 'Resets the multi-turn position to the absolute angle, clearing the turn count.']) },
  ],
  faults: [
    { bit: 10, key: 'magnet_missing', label: tx(['Mıknatıs yok', 'Magnet missing']) },
    { bit: 11, key: 'magnet_weak', label: tx(['Mıknatıs zayıf', 'Magnet weak']) },
    { bit: 12, key: 'magnet_strong', label: tx(['Mıknatıs çok güçlü', 'Magnet too strong']) },
  ],
  selfTestBits: [
    { bit: 0, key: 'sensor_comm', label: tx(['Sensör iletişimi', 'Sensor communication']) },
    { bit: 1, key: 'magnet', label: tx(['Mıknatıs', 'Magnet']) },
    { bit: 2, key: 'param_storage', label: tx(['Ayar belleği', 'Settings memory']) },
  ],
  stream: { minPeriodUs: 1000 },
  tuner: { loops: [] },
});
