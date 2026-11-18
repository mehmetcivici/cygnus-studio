import { DevType, Model, PType } from '../../core/constants';
import { opts, pBool, pEnum, pF32, sig, tx } from '../builders';
import { defineModel } from '../common';
import type { ModelDef } from '../schema';

export const GyroCalStatus = { NONE: 0, RUNNING: 1, DONE: 2, FAILED_MOTION: 3 } as const;

const AXIS_SIGNALS = (['x', 'y', 'z'] as const).map((a, i) =>
  sig(4 + i, `gyro.${a}`, '°/s', [`Açısal hız ${a.toUpperCase()}`, `Angular rate ${a.toUpperCase()}`], [-2000, 2000], 1),
);
const ACCEL_SIGNALS = (['x', 'y', 'z'] as const).map((a, i) =>
  sig(7 + i, `accel.${a}`, 'g', [`İvme ${a.toUpperCase()}`, `Acceleration ${a.toUpperCase()}`], [-16, 16], 3),
);
const QUAT_SIGNALS = (['w', 'x', 'y', 'z'] as const).map((a, i) =>
  sig(10 + i, `quat.${a}`, '', [`Kuaterniyon ${a}`, `Quaternion ${a}`], [-1, 1], 4),
);

const Q14 = 1 / 16384;

export const GYRO: ModelDef = defineModel({
  model: Model.GYRO,
  devType: DevType.GYRO,
  key: 'gyro',
  name: tx(['CAN jiroskop', 'CAN gyro']),
  category: 'sensor',
  catalogRev: 1,
  description: tx([
    'Sensör füzyonlu ataletsel ölçüm birimi; yaw, pitch, roll, açısal hız ve ivme bildirir.',
    'Inertial measurement unit with sensor fusion; reports yaw, pitch, roll, angular rate and acceleration.',
  ]),
  common: { actuator: false, termination: 'fixed' },
  groups: [
    { key: 'mount', label: tx(['Montaj', 'Mounting']) },
    { key: 'fusion', label: tx(['Füzyon ve kalibrasyon', 'Fusion and calibration']) },
    { key: 'imu', label: tx(['Sensör', 'Sensor']) },
  ],
  params: [
    pF32(0x0100, 'mount.yaw_deg', 'mount', ['Montaj · Yaw ofseti', 'Mount · Yaw offset'],
      ['Kartın robota göre yaw yönündeki dönüklüğü.', 'Rotation of the board relative to the robot about the yaw axis.'],
      { unit: '°', min: -180, max: 180, step: 0.1, def: 0 }),
    pF32(0x0101, 'mount.pitch_deg', 'mount', ['Montaj · Pitch ofseti', 'Mount · Pitch offset'],
      ['Kartın robota göre pitch yönündeki eğikliği; "Seviyeyi sıfırla" doldurur.', 'Tilt of the board relative to the robot about pitch; filled by "Level here".'],
      { unit: '°', min: -180, max: 180, step: 0.1, def: 0 }),
    pF32(0x0102, 'mount.roll_deg', 'mount', ['Montaj · Roll ofseti', 'Mount · Roll offset'],
      ['Kartın robota göre roll yönündeki eğikliği; "Seviyeyi sıfırla" doldurur.', 'Tilt of the board relative to the robot about roll; filled by "Level here".'],
      { unit: '°', min: -180, max: 180, step: 0.1, def: 0 }),
    pEnum(0x0110, 'fusion.mode', 'fusion', ['Füzyon kipi', 'Fusion mode'],
      ['6 eksen yalnızca jiroskop ve ivmeölçeri, 9 eksen ayrıca manyetometreyi kullanır.', '6-axis uses gyro and accelerometer only; 9-axis also uses the magnetometer.'],
      opts([0, '6 eksen', '6-axis'], [1, '9 eksen (pusulalı)', '9-axis (compass)']), 0),
    pBool(0x0111, 'fusion.cal_on_boot', 'fusion', ['Açılışta sapma kalibrasyonu', 'Bias calibration at boot'],
      ['Açılışta kart hareketsizken jiroskop sapmasını otomatik ölçer.', 'Measures gyro bias automatically at boot while the board is still.'],
      true),
    pF32(0x0112, 'fusion.cal_time_s', 'fusion', ['Kalibrasyon süresi', 'Calibration time'],
      ['Sapma kalibrasyonunun sürdüğü zaman; uzun süre daha az kayma demektir.', 'Duration of bias calibration; longer means less drift.'],
      { unit: 's', min: 1, max: 30, step: 0.5, def: 4 }),
    pF32(0x0113, 'fusion.motion_dps', 'fusion', ['Hareket algılama eşiği', 'Motion detection threshold'],
      ['Kalibrasyon sırasında bu açısal hız aşılırsa kalibrasyon iptal edilir.', 'Calibration is aborted if the angular rate exceeds this value.'],
      { unit: '°/s', min: 0.1, max: 20, step: 0.1, def: 2, advanced: true }),
    pBool(0x0114, 'fusion.yaw_invert', 'fusion', ['Yaw yönünü çevir', 'Invert yaw'],
      ['Saat yönünde dönüşün pozitif yaw sayılmasını sağlar.', 'Makes clockwise rotation count as positive yaw.'],
      false),
    pEnum(0x0115, 'fusion.yaw_wrap', 'fusion', ['Yaw biçimi', 'Yaw format'],
      ['Yaw sürekli birikir mi yoksa −180..+180 aralığına mı sarılır.', 'Whether yaw accumulates continuously or wraps to −180..+180.'],
      opts([0, 'Sürekli', 'Continuous'], [1, '−180 … +180', '−180 … +180']), 0),
    pEnum(0x0120, 'imu.gyro_range', 'imu', ['Jiroskop aralığı', 'Gyro range'],
      ['Ölçülebilecek en yüksek açısal hız; küçük aralık daha hassastır.', 'Highest measurable angular rate; a smaller range is more precise.'],
      opts([250, '±250 dps', '±250 dps'], [500, '±500 dps', '±500 dps'], [1000, '±1000 dps', '±1000 dps'], [2000, '±2000 dps', '±2000 dps']), 2000,
      { rebootRequired: true }),
    pEnum(0x0121, 'imu.accel_range', 'imu', ['İvmeölçer aralığı', 'Accelerometer range'],
      ['Ölçülebilecek en yüksek ivme; çarpışmalar için geniş aralık seçin.', 'Highest measurable acceleration; choose a wide range for collisions.'],
      opts([2, '±2 g', '±2 g'], [4, '±4 g', '±4 g'], [8, '±8 g', '±8 g'], [16, '±16 g', '±16 g']), 8,
      { rebootRequired: true }),
    pEnum(0x0122, 'imu.lpf_hz', 'imu', ['Alçak geçiren filtre', 'Low-pass filter'],
      ['Ham sensör verisine uygulanan filtrenin kesim frekansı.', 'Cutoff of the filter applied to raw sensor data.'],
      opts([10, '10 Hz', '10 Hz'], [20, '20 Hz', '20 Hz'], [41, '41 Hz', '41 Hz'], [92, '92 Hz', '92 Hz'], [184, '184 Hz', '184 Hz']), 92),
  ],
  signals: [
    sig(1, 'yaw', '°', ['Yaw', 'Yaw'], [-180, 180], 2),
    sig(2, 'pitch', '°', ['Pitch', 'Pitch'], [-90, 90], 2),
    sig(3, 'roll', '°', ['Roll', 'Roll'], [-180, 180], 2),
    ...AXIS_SIGNALS,
    ...ACCEL_SIGNALS,
    ...QUAT_SIGNALS,
    sig(14, 'temp', '°C', ['Sıcaklık', 'Temperature'], [0, 85], 0),
    sig(15, 'cal.status', '', ['Kalibrasyon durumu', 'Calibration status'], [0, 3], 0, {
      options: opts(
        [GyroCalStatus.NONE, 'Kalibre edilmedi', 'Not calibrated'],
        [GyroCalStatus.RUNNING, 'Kalibre ediliyor', 'Calibrating'],
        [GyroCalStatus.DONE, 'Kalibre edildi', 'Calibrated'],
        [GyroCalStatus.FAILED_MOTION, 'Hareket nedeniyle başarısız', 'Failed due to motion'],
      ),
    }),
  ],
  statusFrames: [
    {
      index: 0,
      label: tx(['Yönelim', 'Orientation']),
      defaultPeriodMs: 10,
      fields: [
        { signal: 'yaw', byte: 0, type: 'f32' },
        { signal: 'pitch', byte: 4, type: 'i16', scale: 0.01 },
        { signal: 'roll', byte: 6, type: 'i16', scale: 0.01 },
      ],
    },
    {
      index: 1,
      label: tx(['Açısal hız', 'Angular rate']),
      defaultPeriodMs: 20,
      fields: [
        { signal: 'gyro.x', byte: 0, type: 'i16', scale: 0.1 },
        { signal: 'gyro.y', byte: 2, type: 'i16', scale: 0.1 },
        { signal: 'gyro.z', byte: 4, type: 'i16', scale: 0.1 },
        { signal: 'cal.status', byte: 6, type: 'u8', bit: 0, bits: 2 },
        { signal: 'temp', byte: 7, type: 'i8' },
      ],
    },
    {
      index: 2,
      label: tx(['İvme', 'Acceleration']),
      defaultPeriodMs: 50,
      fields: [
        { signal: 'accel.x', byte: 0, type: 'i16', scale: 0.001 },
        { signal: 'accel.y', byte: 2, type: 'i16', scale: 0.001 },
        { signal: 'accel.z', byte: 4, type: 'i16', scale: 0.001 },
      ],
    },
    {
      index: 3,
      label: tx(['Kuaterniyon', 'Quaternion']),
      defaultPeriodMs: 50,
      fields: [
        { signal: 'quat.w', byte: 0, type: 'i16', scale: Q14 },
        { signal: 'quat.x', byte: 2, type: 'i16', scale: Q14 },
        { signal: 'quat.y', byte: 4, type: 'i16', scale: Q14 },
        { signal: 'quat.z', byte: 6, type: 'i16', scale: Q14 },
      ],
    },
  ],
  controls: [],
  actions: [
    { cmd: 0x40, key: 'calibrate', label: tx(['Sapmayı kalibre et', 'Calibrate bias']),
      help: tx(['Kartı tamamen hareketsiz tutun; jiroskop sapması ölçülür.', 'Keep the board completely still; the gyro bias is measured.']),
      longRunning: true },
    { cmd: 0x41, key: 'set_yaw', label: tx(["Yaw'ı sıfırla", 'Reset yaw']),
      help: tx(["Yaw'ı verilen değere (varsayılan 0) ayarlar.", 'Sets yaw to the given value (default 0).']),
      arg: { ptype: PType.F32, label: tx(['Yeni yaw', 'New yaw']), unit: '°', min: -360, max: 360, default: 0 } },
    { cmd: 0x42, key: 'level_here', label: tx(['Seviyeyi sıfırla', 'Level here']),
      help: tx(['Şu anki pitch ve roll değerlerini montaj ofsetine yazar; robot düz zeminde olmalı.', 'Stores the current pitch and roll as mounting offsets; the robot must be on level ground.']),
      confirm: true },
  ],
  faults: [
    { bit: 10, key: 'cal_motion', label: tx(['Kalibrasyon sırasında hareket', 'Motion during calibration']) },
    { bit: 11, key: 'saturation', label: tx(['Sensör doygunluğu', 'Sensor saturation']) },
  ],
  selfTestBits: [
    { bit: 0, key: 'gyro', label: tx(['Jiroskop', 'Gyroscope']) },
    { bit: 1, key: 'accel', label: tx(['İvmeölçer', 'Accelerometer']) },
    { bit: 2, key: 'magnetometer', label: tx(['Manyetometre', 'Magnetometer']) },
    { bit: 3, key: 'param_storage', label: tx(['Ayar belleği', 'Settings memory']) },
  ],
  stream: { minPeriodUs: 1000 },
  tuner: { loops: [] },
});
