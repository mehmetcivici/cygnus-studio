import {
  Command,
  CommandStatus,
  CommonPid,
  DataBitrate,
  DeviceState,
  FaultBit,
  FwStatus,
  ParamStatus,
  Timing,
} from '../core/constants';
import { opts, pBool, pEnum, pU32, tx } from './builders';
import type { BitDef, GroupDef, ModelDef, ParamDef, StatusFrameDef, Text } from './schema';

// Shared catalog pieces: common parameters (PROTOCOL §5) and labels for protocol-level enums.

export const COMMON_GROUPS: GroupDef[] = [
  { key: 'can', label: tx(['CAN hattı', 'CAN bus']) },
  { key: 'control', label: tx(['Kontrol', 'Control']) },
  { key: 'status', label: tx(['Durum çerçeveleri', 'Status frames']) },
];

export const STATUS_PERIOD_MIN_MS = 5;
export const STATUS_PERIOD_MAX_MS = 60000;

export function statusPeriodPid(n: number): number {
  return CommonPid.STATUS_PERIOD_BASE + n;
}

export function statusPeriodKey(n: number): string {
  return `status.${n}.period_ms`;
}

export interface CommonParamOptions {
  /** Actuators get `ctrl.timeout_ms`. */
  actuator: boolean;
  /** Whether `can.termination` is a real switch or a read-only 0. */
  termination: 'switchable' | 'fixed';
}

export function commonParams(o: CommonParamOptions, statusFrames: StatusFrameDef[]): ParamDef[] {
  const out: ParamDef[] = [
    pEnum(
      CommonPid.CAN_DATA_BITRATE,
      'can.data_bitrate',
      'can',
      ['FD veri hızı', 'FD data bitrate'],
      [
        'CAN-FD veri evresinin hızı; Klasik seçilirse kart FD çerçevesi göndermez (roboRIO ve MCP2515 hatları için).',
        'CAN-FD data phase bitrate; Classic makes the board send no FD frames (for roboRIO and MCP2515 buses).',
      ],
      opts(
        [DataBitrate.CLASSIC, 'Klasik (FD yok)', 'Classic (no FD)'],
        [DataBitrate.M2, '2 Mbit/s', '2 Mbit/s'],
        [DataBitrate.M5, '5 Mbit/s', '5 Mbit/s'],
        [DataBitrate.M8, '8 Mbit/s', '8 Mbit/s'],
      ),
      DataBitrate.M2,
      { rebootRequired: true },
    ),
    o.termination === 'switchable'
      ? pBool(
          CommonPid.CAN_TERMINATION,
          'can.termination',
          'can',
          ['Hat sonlandırma (120 Ω)', 'Bus termination (120 Ω)'],
          [
            'Kart hattın ucundaysa açın; hatta tam iki sonlandırma olmalıdır.',
            'Turn on when the board sits at an end of the bus; a bus needs exactly two terminations.',
          ],
          false,
        )
      : pBool(
          CommonPid.CAN_TERMINATION,
          'can.termination',
          'can',
          ['Hat sonlandırma (120 Ω)', 'Bus termination (120 Ω)'],
          [
            'Bu kartta anahtarlanabilir sonlandırma yok; değer her zaman kapalıdır.',
            'This board has no switchable termination; the value is always off.',
          ],
          false,
          { readOnly: true },
        ),
  ];
  if (o.actuator) {
    out.push(
      pU32(
        CommonPid.CTRL_TIMEOUT_MS,
        'ctrl.timeout_ms',
        'control',
        ['Komut zaman aşımı', 'Command timeout'],
        [
          'Bu süre içinde yeni kontrol çerçevesi gelmezse çıkış nötre döner ve uyarı verilir.',
          'If no new control frame arrives within this time the output goes neutral and a warning is raised.',
        ],
        { unit: 'ms', min: 20, max: 2000, step: 10, def: Timing.CTRL_TIMEOUT_DEFAULT_MS },
      ),
    );
  }
  for (const f of statusFrames) {
    out.push(
      pU32(
        statusPeriodPid(f.index),
        statusPeriodKey(f.index),
        'status',
        [`Durum ${f.index} periyodu · ${f.label.tr}`, `Status ${f.index} period · ${f.label.en}`],
        [
          `${f.label.tr} çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az ${STATUS_PERIOD_MIN_MS} ms.`,
          `Send interval of the ${f.label.en} frame; 0 turns it off, minimum ${STATUS_PERIOD_MIN_MS} ms.`,
        ],
        {
          unit: 'ms',
          min: 0,
          max: STATUS_PERIOD_MAX_MS,
          step: 1,
          def: f.defaultPeriodMs,
          minNonZero: STATUS_PERIOD_MIN_MS,
        },
      ),
    );
  }
  return out;
}

export type ModelSpec = Omit<ModelDef, 'params' | 'groups'> & {
  groups: GroupDef[];
  params: ParamDef[];
  common: CommonParamOptions;
};

/** Adds the common groups and parameters to a model-specific definition. */
export function defineModel(spec: ModelSpec): ModelDef {
  const { common, ...rest } = spec;
  const commons = commonParams(common, spec.statusFrames);
  const usedGroups = new Set(commons.map((p) => p.group));
  return {
    ...rest,
    groups: [...spec.groups, ...COMMON_GROUPS.filter((g) => usedGroups.has(g.key))],
    params: [...spec.params, ...commons],
  };
}

// ---------------------------------------------------------------------------------------
// Labels for protocol-level values, so UIs and generated docs never hard-code them.

export const COMMON_FAULTS: BitDef[] = [
  { bit: FaultBit.UNDERVOLT, key: 'undervolt', label: tx(['Düşük gerilim', 'Undervoltage']) },
  { bit: FaultBit.OVERVOLT, key: 'overvolt', label: tx(['Yüksek gerilim', 'Overvoltage']) },
  { bit: FaultBit.OVERCURRENT, key: 'overcurrent', label: tx(['Aşırı akım', 'Overcurrent']) },
  { bit: FaultBit.OVERTEMP, key: 'overtemp', label: tx(['Aşırı sıcaklık', 'Overtemperature']) },
  { bit: FaultBit.CTRL_TIMEOUT, key: 'ctrl_timeout', label: tx(['Komut zaman aşımı', 'Command timeout']) },
  { bit: FaultBit.SENSOR, key: 'sensor', label: tx(['Sensör hatası', 'Sensor fault']) },
  { bit: FaultBit.HARDWARE, key: 'hardware', label: tx(['Donanım hatası', 'Hardware fault']) },
  { bit: FaultBit.PARAM_CRC, key: 'param_crc', label: tx(['Ayar belleği bozuk', 'Settings memory corrupt']) },
  { bit: FaultBit.CAN_ERR, key: 'can_err', label: tx(['CAN hatası', 'CAN error']) },
  { bit: FaultBit.ESTOP, key: 'estop', label: tx(['Acil durdurma', 'Emergency stop']) },
];

export const COMMON_COMMANDS: ReadonlyArray<{ cmd: number; key: string; label: Text }> = [
  { cmd: Command.REBOOT, key: 'reboot', label: tx(['Yeniden başlat', 'Reboot']) },
  { cmd: Command.ENTER_BOOTLOADER, key: 'enter_bootloader', label: tx(['Önyükleyiciye geç', 'Enter bootloader']) },
  { cmd: Command.SAVE_PARAMS, key: 'save_params', label: tx(['Ayarları karta kaydet', 'Save settings to board']) },
  { cmd: Command.LOAD_DEFAULTS, key: 'load_defaults', label: tx(['Varsayılanları yükle', 'Load defaults']) },
  { cmd: Command.CLEAR_FAULTS, key: 'clear_faults', label: tx(['Hataları temizle', 'Clear faults']) },
  { cmd: Command.SELF_TEST, key: 'self_test', label: tx(['Öz-test', 'Self-test']) },
  { cmd: Command.CLEAR_ESTOP, key: 'clear_estop', label: tx(['Acil durdurmayı kaldır', 'Clear emergency stop']) },
];

export const DEVICE_STATE_LABELS: Readonly<Record<number, Text>> = {
  [DeviceState.BOOT]: tx(['Açılıyor', 'Booting']),
  [DeviceState.BOOTLOADER]: tx(['Önyükleyici', 'Bootloader']),
  [DeviceState.IDLE]: tx(['Boşta', 'Idle']),
  [DeviceState.ACTIVE]: tx(['Çalışıyor', 'Active']),
  [DeviceState.FAULT]: tx(['Hata', 'Fault']),
  [DeviceState.ESTOP]: tx(['Acil durdurma', 'Emergency stop']),
};

export const COMMAND_STATUS_LABELS: Readonly<Record<number, Text>> = {
  [CommandStatus.OK]: tx(['Tamam', 'OK']),
  [CommandStatus.IN_PROGRESS]: tx(['Sürüyor', 'In progress']),
  [CommandStatus.UNSUPPORTED]: tx(['Desteklenmiyor', 'Unsupported']),
  [CommandStatus.INVALID_ARG]: tx(['Geçersiz değer', 'Invalid argument']),
  [CommandStatus.DENIED]: tx(['Şu an yapılamaz', 'Denied']),
  [CommandStatus.FAILED]: tx(['Başarısız', 'Failed']),
};

export const PARAM_STATUS_LABELS: Readonly<Record<number, Text>> = {
  [ParamStatus.OK]: tx(['Tamam', 'OK']),
  [ParamStatus.UNKNOWN_PARAM]: tx(['Bilinmeyen ayar', 'Unknown parameter']),
  [ParamStatus.TYPE_MISMATCH]: tx(['Tip uyuşmuyor', 'Type mismatch']),
  [ParamStatus.OUT_OF_RANGE]: tx(['Aralık dışında', 'Out of range']),
  [ParamStatus.READ_ONLY]: tx(['Salt okunur', 'Read-only']),
  [ParamStatus.DENIED_WHILE_ENABLED]: tx(['Sürülürken değiştirilemez', 'Locked while enabled']),
};

export const FW_STATUS_LABELS: Readonly<Record<number, Text>> = {
  [FwStatus.OK]: tx(['Tamam', 'OK']),
  [FwStatus.BUSY]: tx(['Meşgul', 'Busy']),
  [FwStatus.BAD_OFFSET]: tx(['Sıra bozuldu', 'Bad offset']),
  [FwStatus.BAD_CRC]: tx(['CRC hatalı', 'Bad CRC']),
  [FwStatus.BAD_IMAGE]: tx(['Uyumsuz imaj', 'Bad image']),
  [FwStatus.FLASH_ERROR]: tx(['Flaş yazma hatası', 'Flash error']),
  [FwStatus.WRONG_STATE]: tx(['Yanlış durum', 'Wrong state']),
};
