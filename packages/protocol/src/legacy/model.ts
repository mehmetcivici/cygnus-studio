import { sig, opts } from '../catalog/builders';
import type { ActionDef, ModelDef } from '../catalog/schema';
import { DevType } from '../core/constants';
import { V3Command, V3Health } from './protocol';

/** Legacy boards report no CyCAN model code, so the definition is not in the catalog's code space. */
export const CYNCODER_V3_MODEL = 0;

/** Signal keys of a legacy Cyncoder handle (`position` and `velocity` follow the CyCAN Cyncoder's units). */
export const V3Signal = {
  POSITION: 'position',
  POSITION_DEG: 'position.deg',
  VELOCITY: 'velocity',
  VELOCITY_DPS: 'velocity.dps',
  ABS_POSITION: 'abs.position',
  ABS_TICKS: 'abs.ticks',
  MAGNET_HEALTH: 'magnet.health',
  MAGNET_AGC: 'magnet.agc',
  MAGNET_FIELD: 'magnet.field',
  PROTOCOL_VERSION: 'protocol.version',
  BUS_OFF_COUNT: 'bus_off.count',
} as const;

/** Action `cmd` is `0x40 | v3 API index`, which keeps catalog-style command codes (>= 0x40). */
export const V3_ACTION_BASE = 0x40;

const action = (index: number, a: Omit<ActionDef, 'cmd'>): ActionDef => ({ cmd: V3_ACTION_BASE | index, ...a });

/**
 * Form/tile definition for boards speaking Cyncoder v3. It is deliberately not part of the
 * model catalog (no CyCAN codes, no parameters): the legacy driver hands it out as the handle's `def`.
 */
export const CYNCODER_V3_DEF: ModelDef = {
  model: CYNCODER_V3_MODEL,
  devType: DevType.MISC,
  key: 'cyncoder_v3',
  name: { tr: 'Cyncoder v3 (eski protokol)', en: 'Cyncoder v3 (legacy protocol)' },
  category: 'sensor',
  catalogRev: 1,
  description: {
    tr: 'Eski FRC protokolünü konuşan Cyncoder 1.4 kartı: konum, hız ve mıknatıs sağlığı izlenir; sıfırlama, fabrika ayarı ve LED eylemleri vardır. Ayarlar ve firmware bu protokolle değiştirilemez.',
    en: 'Cyncoder 1.4 board speaking the legacy FRC protocol: position, velocity and magnet health are monitored; zero, factory default and LED actions are available. Parameters and firmware cannot be changed over this protocol.',
  },
  groups: [],
  params: [],
  signals: [
    sig(1, V3Signal.POSITION, 'rot', ['Çok turlu konum', 'Multi-turn position'], [-10, 10], 4),
    sig(2, V3Signal.POSITION_DEG, '°', ['Çok turlu konum (derece)', 'Multi-turn position (degrees)'], [-3600, 3600], 2),
    sig(3, V3Signal.VELOCITY, 'rpm', ['Hız', 'Velocity'], [-6000, 6000], 1),
    sig(4, V3Signal.VELOCITY_DPS, '°/s', ['Hız (derece/sn)', 'Velocity (degrees/s)'], [-36000, 36000], 1),
    sig(5, V3Signal.ABS_POSITION, 'rot', ['Mutlak konum', 'Absolute position'], [0, 1], 4),
    sig(6, V3Signal.ABS_TICKS, '', ['Mutlak tik', 'Absolute ticks'], [0, 4095], 0),
    sig(7, V3Signal.MAGNET_HEALTH, '', ['Mıknatıs sağlığı', 'Magnet health'], [-1, 3], 0, {
      options: opts(
        [V3Health.GOOD, 'İyi', 'Good'],
        [V3Health.FAR, 'Zayıf / uzak', 'Weak / far'],
        [V3Health.ERROR, 'Yok veya çok yakın', 'Missing or too close'],
        [V3Health.SENSOR_FAULT, 'Sensör arızası', 'Sensor fault'],
        [V3Health.UNKNOWN, 'Bilinmiyor', 'Unknown'],
      ),
    }),
    sig(8, V3Signal.MAGNET_AGC, '', ['Mıknatıs kazancı (AGC)', 'Magnet gain (AGC)'], [0, 255], 0),
    sig(9, V3Signal.MAGNET_FIELD, '', ['Alan şiddeti', 'Field strength'], [0, 4095], 0),
    sig(10, V3Signal.PROTOCOL_VERSION, '', ['Protokol sürümü', 'Protocol version'], [0, 3], 0),
    sig(11, V3Signal.BUS_OFF_COUNT, '', ['Bus-off sayacı', 'Bus-off count'], [0, 255], 0),
  ],
  statusFrames: [],
  controls: [],
  actions: [
    action(V3Command.SET_ZERO, {
      key: 'zero_here',
      label: { tr: 'Buradan sıfırla', en: 'Zero here' },
      help: {
        tr: 'Şu anki açıyı sıfır yapar ve kartın Flash belleğine yazar.',
        en: 'Makes the current angle zero and writes it to the board\'s Flash.',
      },
      confirm: true,
    }),
    action(V3Command.FACTORY_DEFAULT, {
      key: 'factory_default',
      label: { tr: 'Fabrika ayarına dön', en: 'Factory default' },
      help: {
        tr: 'Kayıtlı sıfır noktasını ve yön ters çevirmeyi varsayılana döndürür; CAN numarası değişmez.',
        en: 'Resets the stored zero point and direction invert; the CAN number is unchanged.',
      },
      confirm: true,
    }),
    action(V3Command.BLINK, {
      key: 'blink',
      label: { tr: 'LED\'i yak', en: 'Blink LED' },
      help: {
        tr: 'Kartın durum LED\'ini yakıp söndürür; hangi fiziksel kart olduğunu anlamak için.',
        en: 'Blinks the board\'s status LED to tell which physical board it is.',
      },
    }),
  ],
  faults: [],
  selfTestBits: [],
  stream: { minPeriodUs: 0 },
  tuner: { loops: [] },
};
