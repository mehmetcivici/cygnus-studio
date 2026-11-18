import { actionByCmd, getModel, paramById, signalBySid, statusFrameByIndex } from '../catalog/catalog';
import {
  COMMAND_STATUS_LABELS,
  COMMON_COMMANDS,
  DEVICE_STATE_LABELS,
  FW_STATUS_LABELS,
  PARAM_STATUS_LABELS,
} from '../catalog/common';
import type { ModelDef, Text } from '../catalog/schema';
import { decodeStatusFrame } from '../catalog/status';
import { toHex } from '../core/bytes';
import { Cls, DevType, MFR, NUM_UNASSIGNED, STREAM_SID_CLEAR } from '../core/constants';
import type { CanFrame } from '../core/frame';
import { decodeId, isToDeviceClass } from '../core/id';
import {
  type DecodedMessage,
  decodeCtrlServo,
  decodeCtrlSet,
  decodeCtrlText,
  decodeMessage,
  streamDataCount,
  streamDataValue,
} from '../core/messages';
import { decodeName } from '../core/text';
import type { DescribeOptions, FrameDescription, FrameField, Lang } from './types';
import { uid48ToHex } from './uid';

const CLASS_NAMES: Readonly<Record<number, string>> = {
  [Cls.CTRL]: 'CTRL',
  [Cls.STATUS]: 'STATUS',
  [Cls.SYS_REQ]: 'SYS_REQ',
  [Cls.SYS_RSP]: 'SYS_RSP',
  [Cls.PARAM_REQ]: 'PARAM_REQ',
  [Cls.PARAM_RSP]: 'PARAM_RSP',
  [Cls.STREAM_REQ]: 'STREAM_REQ',
  [Cls.STREAM_RSP]: 'STREAM_RSP',
  [Cls.FW_REQ]: 'FW_REQ',
  [Cls.FW_RSP]: 'FW_RSP',
  [Cls.ENUM_RSP]: 'ENUM_RSP',
};

const INDEX_NAMES: Readonly<Record<number, readonly string[]>> = {
  [Cls.SYS_REQ]: ['ENUM_REQ', 'ASSIGN_ID', 'IDENTIFY', 'INFO_REQ', 'NAME_SET', 'COMMAND', 'FAULT_REQ', 'ESTOP'],
  [Cls.SYS_RSP]: ['HEARTBEAT', '', '', 'INFO_RSP', '', 'COMMAND_RSP', 'FAULT_RSP'],
  [Cls.PARAM_REQ]: ['GET', 'SET'],
  [Cls.PARAM_RSP]: ['VALUE'],
  [Cls.STREAM_REQ]: ['CONFIG', 'START', 'STOP'],
  [Cls.STREAM_RSP]: ['DATA'],
  [Cls.FW_REQ]: ['BEGIN', 'DATA', 'END'],
  [Cls.FW_RSP]: ['ACK'],
};

const t = (tr: string, en: string): Text => ({ tr, en });

const DEVTYPE_NAMES: Readonly<Record<number, Text>> = {
  [DevType.BROADCAST]: t('Yayın', 'Broadcast'),
  [DevType.MOTOR_CONTROLLER]: t('Motor sürücü', 'Motor controller'),
  [DevType.GYRO]: t('Jiroskop', 'Gyro'),
  [DevType.ENCODER]: t('Kodlayıcı', 'Encoder'),
  [DevType.POWER_DISTRIBUTION]: t('Güç dağıtım', 'Power distribution'),
  [DevType.MISC]: t('Diğer', 'Miscellaneous'),
  [DevType.SERVO_CONTROLLER]: t('Servo sürücü', 'Servo controller'),
};

/** Labels of decoded message fields shown in the CAN monitor. */
const FIELD_LABELS: Readonly<Record<string, Text>> = {
  filter: t('Süzgeç', 'Filter'),
  uid48: t('UID', 'UID'),
  newNum: t('Yeni numara', 'New number'),
  persist: t('Kalıcı', 'Persistent'),
  seconds: t('Süre (s)', 'Seconds'),
  page: t('Sayfa', 'Page'),
  bytes: t('Veri', 'Data'),
  cmd: t('Komut', 'Command'),
  arg: t('Argüman', 'Argument'),
  state: t('Durum', 'State'),
  unsaved: t('Kaydedilmemiş', 'Unsaved'),
  enabled: t('Sürülüyor', 'Enabled'),
  warning: t('Uyarı', 'Warning'),
  identify: t('Tanıtma', 'Identify'),
  fault: t('Hata', 'Fault'),
  uid16: t('UID16', 'UID16'),
  fw: t('Firmware', 'Firmware'),
  model: t('Model', 'Model'),
  hwRev: t('Donanım rev.', 'HW rev'),
  protoMajor: t('Protokol', 'Protocol'),
  protoMinor: t('Protokol alt', 'Protocol minor'),
  catalogRev: t('Katalog rev.', 'Catalog rev'),
  bootloaderVer: t('Önyükleyici', 'Bootloader'),
  gitHash: t('Git', 'Git'),
  buildDay: t('Derleme günü', 'Build day'),
  dirty: t('Kirli', 'Dirty'),
  status: t('Sonuç', 'Status'),
  result: t('Değer', 'Result'),
  active: t('Etkin', 'Active'),
  sticky: t('Kalıcı', 'Sticky'),
  warn: t('Uyarı', 'Warning'),
  num: t('Numara', 'Number'),
  conflict: t('Çakışma', 'Conflict'),
  bootloader: t('Önyükleyici', 'Bootloader'),
  pid: t('Ayar', 'Parameter'),
  ptype: t('Tip', 'Type'),
  value: t('Değer', 'Value'),
  slot: t('Yuva', 'Slot'),
  sid: t('Sinyal', 'Signal'),
  period100us: t('Periyot (100 µs)', 'Period (100 µs)'),
  seq: t('Sıra', 'Seq'),
  firstSlot: t('İlk yuva', 'First slot'),
  t100us: t('Zaman (100 µs)', 'Time (100 µs)'),
  size: t('Boyut', 'Size'),
  crc32: t('CRC32', 'CRC32'),
  offset: t('Ofset', 'Offset'),
  window: t('Pencere', 'Window'),
  nextOffset: t('Sonraki ofset', 'Next offset'),
  mode: t('Kip', 'Mode'),
  flags: t('Bayraklar', 'Flags'),
  channel: t('Kanal', 'Channel'),
  line: t('Satır', 'Line'),
  col: t('Sütun', 'Column'),
  text: t('Metin', 'Text'),
  name: t('Ad', 'Name'),
};

const WORDS = {
  yes: t('evet', 'yes'),
  no: t('hayır', 'no'),
  broadcast: t('yayın', 'broadcast'),
  all: t('tüm kartlar', 'all boards'),
  unassigned: t('atanmamış', 'unassigned'),
  legacy: t('Cyncoder v3 (eski)', 'Cyncoder v3 (legacy)'),
  foreign: t('yabancı çerçeve', 'foreign frame'),
};

const PTYPE_NAMES = ['u32', 'i32', 'f32', 'bool', 'enum'];

/** Number for display: up to `digits` decimals, trailing zeros dropped, decimal comma in Turkish. */
function fmt(v: number, digits = 3, lang: Lang = 'en'): string {
  if (!Number.isFinite(v)) return String(v);
  const s = Number.isInteger(v) ? String(v) : v.toFixed(digits).replace(/\.?0+$/, '');
  return lang === 'tr' ? s.replace('.', ',') : s;
}

const hex = (v: number, w: number): string => `0x${v.toString(16).toUpperCase().padStart(w, '0')}`;

function spacedHex(d: Uint8Array): string {
  return toHex(d).replace(/(..)(?!$)/g, '$1 ');
}

/**
 * Turns a frame into something a CAN monitor can show: direction, class/index names,
 * address, decoded fields (STATUS signals through the catalog when the sender's model is
 * known) and the raw payload. Foreign and unknown frames get FRC id fields plus raw bytes.
 */
export function describeFrame(frame: CanFrame, opts: DescribeOptions = {}): FrameDescription {
  const lang: Lang = opts.lang ?? 'tr';
  const L = (x: Text): string => x[lang];
  const id = decodeId(frame.id);
  const raw = spacedHex(frame.data);
  const base = {
    devType: id.devType,
    devTypeName: DEVTYPE_NAMES[id.devType] ? L(DEVTYPE_NAMES[id.devType] as Text) : `DEVTYPE ${id.devType}`,
    num: id.num,
    cls: id.cls,
    index: id.index,
    raw,
  };
  if (id.mfr !== MFR || id.cls < 0x10) {
    const legacy = id.mfr === MFR;
    return {
      ...base,
      protocol: legacy ? 'cyncoder-v3' : 'unknown',
      dir: 'unknown',
      address: `#${id.num}`,
      className: legacy ? `LEGACY/${id.cls}` : `MFR ${id.mfr} · API ${id.cls}`,
      indexName: String(id.index),
      summary: `${legacy ? L(WORDS.legacy) : L(WORDS.foreign)} ${hex(frame.id, 8)}`,
      fields: [],
    };
  }

  const model = opts.modelAt?.(id.devType, id.num);
  const className = CLASS_NAMES[id.cls] ?? hex(id.cls, 2);
  let indexName = INDEX_NAMES[id.cls]?.[id.index] ?? '';
  let address: string;
  if (id.cls === Cls.ENUM_RSP) address = `hash10=${hex((id.index << 6) | id.num, 3)}`;
  else if (id.devType === 0 && id.num === 0) address = L(WORDS.all);
  else if (id.num === 0) address = `${base.devTypeName} · ${L(WORDS.broadcast)}`;
  else if (id.num === NUM_UNASSIGNED) address = `${base.devTypeName} · ${L(WORDS.unassigned)}`;
  else address = `${model ? L(model.name) : base.devTypeName} #${id.num}`;

  const fields: FrameField[] = [];
  const add = (key: string, value: string, label?: string): void => {
    fields.push({ key, label: label ?? (FIELD_LABELS[key] ? L(FIELD_LABELS[key] as Text) : key), value });
  };
  const bool = (b: boolean): string => L(b ? WORDS.yes : WORDS.no);

  if (id.cls === Cls.STATUS) {
    const def = model ? statusFrameByIndex(model, id.index) : undefined;
    if (def) indexName = L(def.label);
    const values = def && model ? decodeStatusFrame(def, frame.data) : null;
    if (values && model) {
      for (const f of def?.fields ?? []) {
        const sig = model.signals.find((s) => s.key === f.signal);
        const v = values[f.signal] ?? NaN;
        const opt = sig?.options?.find((o) => o.value === v);
        add(f.signal, opt ? L(opt.label) : `${fmt(v, sig?.digits ?? 3, lang)}${sig?.unit ? ` ${sig.unit}` : ''}`, sig ? L(sig.label) : f.signal);
      }
    }
  } else if (id.cls === Cls.CTRL) {
    describeCtrl(frame, id.index, model, lang, add);
    const c = model?.controls.find((x) => x.index === id.index);
    indexName = c ? L(c.label) : `CTRL/${id.index}`;
  } else {
    const m = decodeMessage(frame.id, frame.data);
    if (m) describeMessage(m, frame.data, model, lang, add, bool);
  }

  const head = indexName || className;
  const preview = fields
    .slice(0, 4)
    .map((f) => `${f.label}=${f.value}`)
    .join(', ');
  return {
    ...base,
    protocol: 'cycan',
    dir: isToDeviceClass(id.cls) ? 'toDevice' : 'fromDevice',
    address,
    className,
    indexName,
    summary: `${head} · ${address}${preview ? ` · ${preview}` : ''}`,
    fields,
  };
}

type Add = (key: string, value: string, label?: string) => void;

function describeCtrl(frame: CanFrame, index: number, model: ModelDef | undefined, lang: Lang, add: Add): void {
  const c = model?.controls.find((x) => x.index === index);
  if (!c) return;
  if (c.format === 'set') {
    const m = decodeCtrlSet(frame.data);
    if (!m) return;
    const mode = c.modes?.find((x) => x.value === m.mode);
    add('mode', mode ? mode.label[lang] : String(m.mode));
    add('value', `${fmt(m.value, 3, lang)}${mode?.unit ? ` ${mode.unit}` : ''}`);
  } else if (c.format === 'servo4') {
    const m = decodeCtrlServo(frame.data, index);
    if (!m) return;
    const first = c.firstChannel ?? 1;
    m.pulsesUs.forEach((p, i) => add(`ch.${first + i}`, `${p} µs`, `${FIELD_LABELS.channel?.[lang] ?? 'ch'} ${first + i}`));
  } else {
    const m = decodeCtrlText(frame.data);
    if (!m) return;
    add('line', String(m.line));
    add('col', String(m.col));
    add('text', JSON.stringify(m.text));
  }
}

function describeMessage(
  m: DecodedMessage,
  data: Uint8Array,
  model: ModelDef | undefined,
  lang: Lang,
  add: Add,
  bool: (b: boolean) => string,
): void {
  const L = (x: Text | undefined, fallback: string): string => (x ? x[lang] : fallback);
  const cmdName = (cmd: number): string => {
    const common = COMMON_COMMANDS.find((c) => c.cmd === cmd);
    if (common) return common.label[lang];
    const a = model ? actionByCmd(model, cmd) : undefined;
    return a ? a.label[lang] : hex(cmd, 2);
  };
  const paramName = (pid: number): string => {
    const p = model ? paramById(model, pid) : undefined;
    return p ? `${p.key} (${hex(pid, 4)})` : hex(pid, 4);
  };
  switch (m.kind) {
    case 'enumReq':
      add('filter', String(m.filter));
      return;
    case 'assignId':
      add('uid48', uid48ToHex(m.uid48));
      add('newNum', String(m.newNum));
      add('persist', bool(m.persist));
      return;
    case 'identify':
      add('seconds', String(m.seconds));
      return;
    case 'identifyUid':
      add('uid48', uid48ToHex(m.uid48));
      add('seconds', String(m.seconds));
      return;
    case 'infoReq':
      add('page', String(m.page));
      return;
    case 'nameSet':
      add('page', String(m.page));
      add('bytes', spacedHex(m.bytes));
      return;
    case 'command':
      add('cmd', cmdName(m.cmd));
      add('arg', String(m.arg));
      return;
    case 'faultReq':
    case 'estop':
    case 'streamStop':
    case 'fwEnd':
      return;
    case 'heartbeat':
      add('state', L(DEVICE_STATE_LABELS[m.state], String(m.state)));
      add('fault', hex(m.fault, 4));
      add('fw', `${m.fwMajor}.${m.fwMinor}.${m.fwPatch}`);
      add('uid16', hex(m.uid16, 4));
      add('unsaved', bool(m.unsaved));
      add('enabled', bool(m.enabled));
      add('warning', bool(m.warning));
      add('identify', bool(m.identify));
      return;
    case 'infoRsp':
      add('page', String(m.page));
      if (m.section === 'device') {
        const def = getModel(m.model);
        add('model', def ? `${def.name[lang]} (${m.model})` : String(m.model));
        add('hwRev', String(m.hwRev));
        add('protoMajor', `${m.protoMajor}.${m.protoMinor}`);
        add('catalogRev', String(m.catalogRev));
        add('bootloaderVer', String(m.bootloaderVer));
      } else if (m.section === 'build') {
        add('gitHash', m.gitHash.toString(16).padStart(8, '0'));
        add('buildDay', String(m.buildDay));
        add('dirty', bool(m.dirty));
      } else if (m.page >= 4 && m.page <= 6) {
        add('name', JSON.stringify(decodeName(m.bytes)));
      } else {
        add('bytes', spacedHex(m.bytes));
      }
      return;
    case 'commandRsp':
      add('cmd', cmdName(m.cmd));
      add('status', L(COMMAND_STATUS_LABELS[m.status], String(m.status)));
      add('result', String(m.result));
      return;
    case 'faultRsp':
      add('active', hex(m.active, 4));
      add('sticky', hex(m.sticky, 4));
      add('warn', hex(m.warn, 4));
      return;
    case 'enumRsp': {
      const def = getModel(m.model);
      add('uid48', uid48ToHex(m.uid48));
      add('num', String(m.num));
      add('model', def ? `${def.name[lang]} (${m.model})` : String(m.model));
      add('conflict', bool(m.conflict));
      add('bootloader', bool(m.bootloader));
      return;
    }
    case 'paramGet':
      add('pid', paramName(m.pid));
      return;
    case 'paramSet':
    case 'paramValue':
      add('pid', paramName(m.pid));
      add('ptype', PTYPE_NAMES[m.ptype] ?? String(m.ptype));
      add('value', fmt(m.value, 6, lang));
      if (m.kind === 'paramValue') add('status', L(PARAM_STATUS_LABELS[m.status], String(m.status)));
      return;
    case 'streamConfig': {
      add('slot', String(m.slot));
      const s = model ? signalBySid(model, m.sid) : undefined;
      add('sid', m.sid === STREAM_SID_CLEAR ? '—' : s ? `${s.key} (${m.sid})` : String(m.sid));
      return;
    }
    case 'streamStart':
      add('period100us', String(m.period100us));
      return;
    case 'streamData': {
      add('seq', String(m.seq));
      add('firstSlot', String(m.firstSlot));
      add('t100us', String(m.t100us));
      const k = streamDataCount(data);
      for (let i = 0; i < k; i++) add(`slot.${m.firstSlot + i}`, fmt(streamDataValue(data, i), 4, lang), `#${m.firstSlot + i}`);
      return;
    }
    case 'fwBegin':
      add('size', String(m.size));
      add('crc32', hex(m.crc32, 8));
      return;
    case 'fwData':
      add('offset', String(m.offset));
      add('size', String(m.bytes.length));
      return;
    case 'fwAck':
      add('status', L(FW_STATUS_LABELS[m.status], String(m.status)));
      add('window', String(m.window));
      add('nextOffset', String(m.nextOffset));
      return;
    case 'ctrl':
    case 'status':
      return;
  }
}
