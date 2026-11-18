import { CATALOG, PROTO_MAJOR, PROTO_MINOR, getModel, type ModelDef, type ParamDef } from '@cygnus/protocol';
import { getTemplate } from '@cygnus/vehicles';
import { repairVehicleConfig } from '../vehicle/model';
import { fmtValue, t, tl, type Lang } from '../../i18n';
import { LEGACY_MODEL_NAME, type ProjectDevice, type ProjectFile } from '../../core';
import { sameNumber } from './diff';

export interface ReportParam {
  key: string;
  label: string;
  group: string;
  value: string;
  defaultValue: string;
}

export interface ReportCard {
  uid48: string;
  num: number;
  name: string;
  modelName: string;
  modelKey: string;
  devType: number;
  fw: string | null;
  legacy: boolean;
  unknownModel: boolean;
  paramCount: number;
  /** Parameters that differ from the catalog default (read-only ones excluded). */
  changed: ReportParam[];
}

export interface ReportSlot {
  slot: string;
  target: string;
}

export interface ReportVehicle {
  template: string;
  name: string;
  slots: ReportSlot[];
  unboundRequired: number;
}

export interface ReportData {
  lang: Lang;
  projectName: string;
  notes: string;
  generatedAt: string;
  capturedAt: string | null;
  appVersion: string;
  protocol: string;
  cards: ReportCard[];
  vehicle: ReportVehicle | null;
  changedTotal: number;
}

/** Value as a person reads it: enum label, on/off, number with unit. */
export function formatParam(p: ParamDef, value: number, lang: Lang): string {
  if (p.options) {
    const o = p.options.find((x) => x.value === value);
    if (o) return tl(o.label, lang);
  }
  if (p.ptype === 3) return t(value ? 'common.on' : 'common.off', undefined, lang);
  return fmtValue(value, p.unit, p.digits, { lang });
}

function cardOf(d: ProjectDevice, lang: Lang): ReportCard {
  const def: ModelDef | undefined = getModel(d.model);
  const legacy = d.driver !== 'cycan';
  const changed: ReportParam[] = [];
  if (def) {
    const groups = new Map(def.groups.map((g) => [g.key, tl(g.label, lang)]));
    for (const p of def.params) {
      const v = d.params[p.key];
      if (v === undefined || p.readOnly || sameNumber(v, p.default)) continue;
      changed.push({ key: p.key, label: tl(p.label, lang), group: groups.get(p.group) ?? p.group, value: formatParam(p, v, lang), defaultValue: formatParam(p, p.default, lang) });
    }
  }
  return {
    uid48: d.uid48,
    num: d.num,
    name: d.name,
    modelName: projectModelName(d, lang),
    modelKey: def?.key ?? d.modelKey,
    devType: d.devType,
    fw: d.fw,
    legacy,
    unknownModel: !def && !legacy,
    paramCount: Object.keys(d.params).length,
    changed,
  };
}

function vehicleOf(project: ProjectFile, cards: readonly ReportCard[], lang: Lang): ReportVehicle | null {
  if (!project.vehicle) return null;
  const v = repairVehicleConfig(project.vehicle).config;
  const tpl = getTemplate(v.templateId);
  const label = (uid: string): string => {
    const c = cards.find((x) => x.uid48 === uid);
    return c ? `${c.name || c.modelName} #${c.num}` : uid;
  };
  const slots: ReportSlot[] = [];
  let unbound = 0;
  for (const s of tpl?.slots ?? []) {
    const b = v.bindings[s.id];
    if (!b) {
      if (s.required) unbound++;
      continue;
    }
    const target = b.kind === 'device' ? label(b.uid48) : b.kind === 'channel' ? `${label(b.uid48)} / ch ${b.channel}` : b.note || (b.canId !== undefined ? `CAN 0x${b.canId.toString(16)}` : '—');
    slots.push({ slot: tl(s.label, lang), target });
  }
  return { template: tpl ? tl(tpl.name, lang) : v.templateId, name: v.name, slots, unboundRequired: unbound };
}

export function buildReport(project: ProjectFile, lang: Lang, ctx: { appVersion: string; now?: Date }): ReportData {
  const cards = [...project.bus.devices].sort((a, b) => a.devType - b.devType || a.num - b.num || a.uid48.localeCompare(b.uid48)).map((d) => cardOf(d, lang));
  return {
    lang,
    projectName: project.name,
    notes: project.notes,
    generatedAt: (ctx.now ?? new Date()).toISOString(),
    capturedAt: project.bus.capturedAt,
    appVersion: ctx.appVersion,
    protocol: `${PROTO_MAJOR}.${PROTO_MINOR}`,
    cards,
    vehicle: vehicleOf(project, cards, lang),
    changedTotal: cards.reduce((n, c) => n + c.changed.length, 0),
  };
}

export interface CatalogRow {
  model: number;
  key: string;
  name: string;
  devType: number;
  rev: number;
  params: number;
  signals: number;
}

/** Catalog revisions table shown in Settings. */
export function catalogRows(lang: Lang): CatalogRow[] {
  return CATALOG.map((d) => ({ model: d.model, key: d.key, name: tl(d.name, lang), devType: d.devType, rev: d.catalogRev, params: d.params.length, signals: d.signals.length }));
}

/** Model name of a snapshot card: catalog name, the shared legacy name, or "Model N" — never a raw key. */
export function projectModelName(d: Pick<ProjectDevice, 'model' | 'modelKey' | 'driver'>, lang: Lang): string {
  if (d.driver !== 'cycan') return LEGACY_MODEL_NAME[lang];
  const def = getModel(d.model);
  return def ? tl(def.name, lang) : `Model ${d.model}`;
}
