import { DevType, Model } from '../../core/constants';
import { opts, pBool, pEnum, pF32, pU32, sig, tx } from '../builders';
import { defineModel } from '../common';
import type { ModelDef, ParamDef } from '../schema';

const OLED_WATCH_SLOTS = 4;

function watchParams(slot: number): ParamDef[] {
  const base = 0x0110 + (slot - 1) * 4;
  const g = 'watch';
  const L = (tr: string, en: string) => [`İzleme ${slot} · ${tr}`, `Watch ${slot} · ${en}`] as const;
  return [
    pU32(base, `watch.${slot}.devtype`, g, L('Kaynak cihaz tipi', 'Source device type'),
      ['İzlenecek kartın DEVTYPE değeri; 0 yuvayı boşaltır.', 'DEVTYPE of the board to watch; 0 leaves the slot empty.'],
      { min: 0, max: 31, def: 0 }),
    pU32(base + 1, `watch.${slot}.num`, g, L('Kaynak numara', 'Source number'),
      ['İzlenecek kartın CAN numarası.', 'CAN number of the board to watch.'],
      { min: 1, max: 62, def: 1 }),
    pU32(base + 2, `watch.${slot}.frame`, g, L('Durum çerçevesi', 'Status frame'),
      ['Değerin okunacağı STATUS çerçeve numarası.', 'STATUS frame number to read the value from.'],
      { min: 0, max: 15, def: 0 }),
    pU32(base + 3, `watch.${slot}.field`, g, L('Alan no', 'Field number'),
      ['Çerçevedeki alanın katalog sırası (0 ilk alan).', 'Catalog order of the field within the frame (0 is the first).'],
      { min: 0, max: 15, def: 0 }),
  ];
}

export const DEBUG_OLED: ModelDef = defineModel({
  model: Model.DEBUG_OLED,
  devType: DevType.MISC,
  key: 'oled',
  name: tx(['CAN debug OLED', 'CAN debug OLED']),
  category: 'tool',
  catalogRev: 1,
  description: tx([
    'Hattaki kartları ve seçilen değerleri gösteren küçük ekran; bilgisayarsız hızlı kontrol için.',
    'Small display showing boards on the bus and chosen values; for quick checks without a laptop.',
  ]),
  common: { actuator: false, termination: 'fixed' },
  groups: [
    { key: 'display', label: tx(['Ekran', 'Display']) },
    { key: 'watch', label: tx(['İzleme yuvaları', 'Watch slots']) },
  ],
  params: [
    pU32(0x0100, 'oled.brightness', 'display', ['Parlaklık', 'Brightness'],
      ['Ekran parlaklığı; düşük değer ekran ömrünü uzatır.', 'Display brightness; lower values extend panel life.'],
      { unit: '%', min: 0, max: 100, step: 5, def: 80 }),
    pEnum(0x0101, 'oled.rotation', 'display', ['Ekran yönü', 'Display orientation'],
      ['Kart ters monte edildiyse ekranı 180° döndürün.', 'Rotate the display 180° if the board is mounted upside down.'],
      opts([0, 'Normal', 'Normal'], [1, '180° döndürülmüş', 'Rotated 180°']), 0),
    pF32(0x0102, 'oled.page_s', 'display', ['Otomatik sayfa geçişi', 'Auto page interval'],
      ['Sayfalar arasında otomatik geçiş süresi; 0 geçişi kapatır.', 'Time between automatic page changes; 0 disables it.'],
      { unit: 's', min: 0, max: 60, step: 0.5, def: 5 }),
    pBool(0x0103, 'oled.overview_enable', 'display', ['Genel durum sayfası', 'Overview page'],
      ['Hattaki kartları ve hatalarını listeleyen sayfayı gösterir.', 'Shows the page listing boards on the bus and their faults.'], true),
    ...Array.from({ length: OLED_WATCH_SLOTS }, (_, i) => watchParams(i + 1)).flat(),
  ],
  signals: [
    sig(1, 'bus.devices', '', ['Görülen cihaz sayısı', 'Devices seen'], [0, 64], 0),
    sig(2, 'bus.load', '%', ['Hat yükü', 'Bus load'], [0, 100], 1),
    sig(3, 'bus.error_frames', '', ['Hata çerçevesi sayısı', 'Error frames'], [0, 1000], 0),
  ],
  statusFrames: [
    {
      index: 0,
      label: tx(['Hat istatistiği', 'Bus statistics']),
      defaultPeriodMs: 500,
      fields: [
        { signal: 'bus.devices', byte: 0, type: 'u8' },
        { signal: 'bus.load', byte: 2, type: 'u16', scale: 0.01 },
        { signal: 'bus.error_frames', byte: 4, type: 'u32' },
      ],
    },
  ],
  controls: [{ index: 0, key: 'text', label: tx(['Metin yaz', 'Write text']), format: 'text' }],
  actions: [],
  faults: [],
  selfTestBits: [
    { bit: 0, key: 'display', label: tx(['Ekran', 'Display']) },
    { bit: 1, key: 'param_storage', label: tx(['Ayar belleği', 'Settings memory']) },
  ],
  stream: { minPeriodUs: 10000 },
  tuner: { loops: [] },
});

// The USB-CAN adapter is the transport itself (slcan); its catalog entry only identifies it.
export const USB_CAN: ModelDef = defineModel({
  model: Model.USB_CAN,
  devType: DevType.MISC,
  key: 'usbcan',
  name: tx(['USB-CAN adaptör', 'USB-CAN adapter']),
  category: 'tool',
  catalogRev: 1,
  description: tx([
    'Bilgisayarı CAN hattına bağlayan slcan uyumlu adaptör; hat istatistikleri adaptörden okunur.',
    'slcan-compatible adapter connecting the computer to the CAN bus; bus statistics come from the adapter.',
  ]),
  common: { actuator: false, termination: 'switchable' },
  groups: [],
  params: [],
  signals: [],
  statusFrames: [],
  controls: [],
  actions: [],
  faults: [],
  selfTestBits: [],
  stream: { minPeriodUs: 10000 },
  tuner: { loops: [] },
});
