import { CATALOG, NUM_MAX, NUM_MIN, paramByKey } from '@cygnus/protocol';
import { slotDevTypes } from './templates/helpers';
import type { LocalizedText, SlotBinding, VehicleConfig, VehicleSlot, VehicleTemplate } from './types';

export interface TemplateIssue { slotId?: string; detail: string }

const modelByKey = (key: string) => CATALOG.find((m) => m.key === key);

/** Developer-facing consistency check of a template against the catalog. */
export function validateTemplate(tpl: VehicleTemplate): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const add = (detail: string, slotId?: string): void => {
    issues.push(slotId === undefined ? { detail } : { detail, slotId });
  };
  if (!(tpl.size.w > 0 && tpl.size.h > 0)) add('size must be positive');
  const seen = new Set<string>();
  for (const s of tpl.slots) {
    if (seen.has(s.id)) add('duplicate slot id', s.id);
    seen.add(s.id);
    if (Math.abs(s.pos.x) > 1 || Math.abs(s.pos.y) > 1) add('pos outside −1..1', s.id);
    if (s.accepts.length === 0) add('no accepted models', s.id);
    if (s.suggestedNum !== undefined && (!Number.isInteger(s.suggestedNum) || s.suggestedNum < NUM_MIN || s.suggestedNum > NUM_MAX)) add('suggestedNum out of range', s.id);
    if (s.spin !== undefined && s.role !== 'propeller') add('spin only applies to propellers', s.id);
    const defs = s.accepts.map((a) => {
      const d = modelByKey(a.model);
      if (!d) add(`unknown model key ${a.model}`, s.id);
      else if (a.via === 'channel' && d.key !== 'servo16') add(`${a.model} has no channels`, s.id);
      return d;
    });
    for (const key of Object.keys(s.presets ?? {})) {
      if (!defs.some((d) => d && paramByKey(d, key))) add(`preset key ${key} not in any accepted model`, s.id);
    }
  }
  // The bus address is DEVTYPE + NUM: two slots that may hold boards of one type must not
  // suggest the same number (e.g. power distribution and SoC regulator share DEVTYPE 8).
  const byAddr = new Map<string, string>();
  for (const s of tpl.slots) {
    if (s.suggestedNum === undefined) continue;
    for (const t of slotDevTypes(s)) {
      const k = `${t}:${s.suggestedNum}`;
      const other = byAddr.get(k);
      if (other) add(`suggestedNum ${s.suggestedNum} also used by ${other} (DEVTYPE ${t})`, s.id);
      else byAddr.set(k, s.id);
    }
  }
  return issues;
}

export type ConfigIssueCode =
  | 'templateMismatch'
  | 'unknownSlot'
  | 'missingRequired'
  | 'duplicateDevice'
  | 'duplicateChannel'
  | 'modelMismatch'
  | 'invalidChannel'
  | 'externalNotAllowed';

export interface ConfigIssue { code: ConfigIssueCode; slotId?: string; message: LocalizedText }

const ACTUATORS = new Set(['drive', 'steer', 'thruster', 'propeller', 'joint', 'pan', 'tilt', 'surface', 'gripper', 'aux']);
const norm = (uid: string): string => uid.toLowerCase();

function accepted(slot: VehicleSlot, b: Exclude<SlotBinding, { kind: 'external' }>): boolean {
  return slot.accepts.some((a) => a.model === b.model && a.via === b.kind);
}

export function validateConfig(tpl: VehicleTemplate, cfg: VehicleConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (code: ConfigIssueCode, tr: string, en: string, slotId?: string): void => {
    issues.push(slotId === undefined ? { code, message: { tr, en } } : { code, slotId, message: { tr, en } });
  };
  if (cfg.templateId !== tpl.id) add('templateMismatch', 'Yapılandırma başka bir şablona ait.', 'The configuration belongs to a different template.');
  const slots = new Map(tpl.slots.map((s) => [s.id, s]));
  const deviceUse = new Map<string, string>(); // uid → slot using it as a whole device
  const channelUse = new Map<string, string>(); // uid:channel → slot
  const cardKinds = new Map<string, { device?: string; channel?: string }>();

  for (const [slotId, b] of Object.entries(cfg.bindings)) {
    const slot = slots.get(slotId);
    if (!slot) { add('unknownSlot', `Şablonda "${slotId}" yuvası yok.`, `The template has no slot "${slotId}".`, slotId); continue; }
    if (b.kind === 'external') {
      if (!ACTUATORS.has(slot.role)) add('externalNotAllowed', 'Bu yuva harici cihaz olamaz.', 'This slot cannot be an external device.', slotId);
      continue;
    }
    if (!accepted(slot, b)) add('modelMismatch', `"${b.model}" bu yuvayla uyumlu değil.`, `"${b.model}" is not compatible with this slot.`, slotId);
    const uid = norm(b.uid48);
    const kinds = cardKinds.get(uid) ?? {};
    if (b.kind === 'channel') {
      if (!Number.isInteger(b.channel) || b.channel < 1 || b.channel > 16) add('invalidChannel', 'Kanal 1–16 olmalı.', 'Channel must be 1–16.', slotId);
      const ck = `${uid}:${b.channel}`;
      const other = channelUse.get(ck);
      if (other) add('duplicateChannel', `Bu kanal "${other}" yuvasına da atanmış.`, `This channel is also assigned to "${other}".`, slotId);
      else channelUse.set(ck, slotId);
      kinds.channel = slotId;
    } else {
      const other = deviceUse.get(uid);
      if (other) add('duplicateDevice', `Bu kart "${other}" yuvasına da atanmış.`, `This board is also assigned to "${other}".`, slotId);
      else deviceUse.set(uid, slotId);
      kinds.device = slotId;
    }
    cardKinds.set(uid, kinds);
  }
  for (const k of cardKinds.values()) {
    if (k.device && k.channel) add('duplicateDevice', 'Bu kart hem tam cihaz hem kanal olarak atanmış.', 'This board is assigned both as a whole device and as a channel.', k.channel);
  }
  for (const s of tpl.slots) {
    if (s.required && !cfg.bindings[s.id]) add('missingRequired', `Zorunlu yuva boş: ${s.label.tr}.`, `Required slot is empty: ${s.label.en}.`, s.id);
  }
  return issues;
}
