import type { Text } from '../catalog/schema';
import { toHex } from '../core/bytes';
import type { CanFrame } from '../core/frame';
import { idClass, idIndex, idNum } from '../core/id';
import type { DescribeOptions, FrameDescription, FrameField, Lang } from '../host/types';
import { CYNCODER_V3_DEF } from './model';
import { V3_ACK_LABELS, V3Class, V3Health, V3_TICKS_PER_REV, isV3Id, parseV3Frame, uidToHex } from './protocol';

const t = (tr: string, en: string): Text => ({ tr, en });

const TELEMETRY_NAMES = ['POSITION_VELOCITY', 'MAGNET_HEALTH', 'DEVICE_UID', 'COMMAND_ACK'] as const;
const COMMAND_NAMES = ['SET_ZERO', 'SET_CONFIG', 'FACTORY_DEFAULT', 'BLINK'] as const;

const LABELS = {
  position: t('Konum (°)', 'Position (°)'),
  velocity: t('Hız (°/s)', 'Velocity (°/s)'),
  health: t('Mıknatıs sağlığı', 'Magnet health'),
  agc: t('AGC', 'AGC'),
  field: t('Alan şiddeti', 'Field strength'),
  ticks: t('Mutlak tik', 'Absolute ticks'),
  version: t('Protokol sürümü', 'Protocol version'),
  busOff: t('Bus-off sayacı', 'Bus-off count'),
  uid: t('UID', 'UID'),
  target: t('Hedef UID', 'Target UID'),
  seq: t('Sıra', 'Seq'),
  command: t('Komut', 'Command'),
  result: t('Sonuç', 'Result'),
  unknown: t('Eski Cyncoder çerçevesi', 'Legacy Cyncoder frame'),
} as const;

const HEALTH_NAMES: Readonly<Record<number, Text>> = {
  [V3Health.GOOD]: t('İyi', 'Good'),
  [V3Health.FAR]: t('Zayıf / uzak', 'Weak / far'),
  [V3Health.ERROR]: t('Yok veya çok yakın', 'Missing or too close'),
  [V3Health.SENSOR_FAULT]: t('Sensör arızası', 'Sensor fault'),
};

/** CAN monitor decoding of Cyncoder v3 frames (identifier layout of PROTOCOL §11). */
export function describeV3Frame(frame: CanFrame, opts: DescribeOptions = {}): FrameDescription | null {
  if (!isV3Id(frame.id)) return null;
  const lang: Lang = opts.lang ?? 'tr';
  const L = (x: Text): string => x[lang];
  const cls = idClass(frame.id);
  const index = idIndex(frame.id);
  const num = idNum(frame.id);
  const fields: FrameField[] = [];
  const add = (key: string, label: Text, value: string): void => {
    fields.push({ key, label: L(label), value });
  };
  const parsed = parseV3Frame(frame);
  const toDevice = cls === V3Class.COMMAND;
  const names: readonly string[] = toDevice ? COMMAND_NAMES : TELEMETRY_NAMES;
  const indexName = names[index] ?? String(index);
  let summary = `${indexName}`;
  switch (parsed.kind) {
    case 'position':
      add('positionDeg', LABELS.position, parsed.value.positionDeg.toFixed(3));
      add('velocityDps', LABELS.velocity, parsed.value.velocityDps.toFixed(2));
      summary = `${parsed.value.positionDeg.toFixed(2)}° · ${parsed.value.velocityDps.toFixed(1)}°/s`;
      break;
    case 'health': {
      const h = parsed.value;
      add('health', LABELS.health, HEALTH_NAMES[h.health] ? L(HEALTH_NAMES[h.health] as Text) : String(h.health));
      add('agc', LABELS.agc, String(h.agc));
      add('field', LABELS.field, String(h.magnitude));
      if (h.ext) {
        add('absTicks', LABELS.ticks, `${h.ext.absTicks}/${V3_TICKS_PER_REV}`);
        add('version', LABELS.version, String(h.ext.version));
        add('busOff', LABELS.busOff, String(h.ext.busOffCount));
      }
      summary = `${HEALTH_NAMES[h.health] ? L(HEALTH_NAMES[h.health] as Text) : h.health} · AGC ${h.agc}`;
      break;
    }
    case 'uid':
      add('uid', LABELS.uid, uidToHex(parsed.uid));
      summary = `UID ${uidToHex(parsed.uid)}`;
      break;
    case 'ack': {
      const a = parsed.ack;
      add('command', LABELS.command, COMMAND_NAMES[a.commandIndex] ?? String(a.commandIndex));
      const label = V3_ACK_LABELS[a.result];
      add('result', LABELS.result, label ? L(label) : String(a.result));
      add('seq', LABELS.seq, String(a.sequence));
      add('uid', LABELS.uid, uidToHex(a.uid));
      summary = `ACK ${COMMAND_NAMES[a.commandIndex] ?? a.commandIndex}: ${label ? L(label) : a.result}`;
      break;
    }
    case 'command':
      if (parsed.uid !== null) add('target', LABELS.target, uidToHex(parsed.uid));
      if (parsed.sequence !== null) add('seq', LABELS.seq, String(parsed.sequence));
      summary = `${indexName}${parsed.uid !== null ? ` → ${uidToHex(parsed.uid)}` : ''}`;
      break;
    case 'malformed':
      summary = L(LABELS.unknown);
      break;
  }
  return {
    protocol: 'cyncoder-v3',
    dir: toDevice ? 'toDevice' : 'fromDevice',
    devType: CYNCODER_V3_DEF.devType,
    devTypeName: L(CYNCODER_V3_DEF.name),
    num,
    address: `Cyncoder v3 #${num}`,
    cls,
    className: toDevice ? 'COMMAND' : 'TELEMETRY',
    index,
    indexName,
    summary,
    fields,
    raw: toHex(frame.data).replace(/(..)(?=.)/g, '$1 '),
  };
}
