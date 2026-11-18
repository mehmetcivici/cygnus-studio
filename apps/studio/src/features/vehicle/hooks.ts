import { useEffect, useMemo, useReducer } from 'react';
import type { VehicleTemplate } from '@cygnus/vehicles';
import { signalHub, useDevices, useProject, type DeviceView } from '../../core';
import { baseTemplate, effectiveTemplate, slotStatuses, type DeviceLite, type SlotStatus } from './model';
import { vehicleSetup } from './project';
import { useDraft } from './store';

export const toLite = (d: DeviceView): DeviceLite => ({
  uid48: d.uid48,
  online: d.online,
  model: d.def?.key,
  devType: d.devType,
  num: d.num,
  name: d.name,
  unassigned: d.unassigned,
  conflict: d.conflict,
});

export function useLites(): { views: readonly DeviceView[]; lites: DeviceLite[]; byUid: Map<string, DeviceView> } {
  const views = useDevices();
  return useMemo(() => ({ views, lites: views.map(toLite), byUid: new Map(views.map((v) => [v.uid48.toLowerCase(), v])) }), [views]);
}

/** Template being edited in the wizard (user slots and tweaks folded in). */
export function useDraftTemplate(): { base: VehicleTemplate | undefined; tpl: VehicleTemplate | undefined } {
  const templateId = useDraft((s) => s.templateId);
  const customSlots = useDraft((s) => s.customSlots);
  const tweaks = useDraft((s) => s.tweaks);
  const bindings = useDraft((s) => s.bindings);
  return useMemo(() => {
    const base = templateId ? baseTemplate(templateId, customSlots) : undefined;
    return { base, tpl: base ? effectiveTemplate(base, tweaks, bindings) : undefined };
  }, [templateId, customSlots, tweaks, bindings]);
}

/** The saved vehicle (project), its template and slot states. */
export function useSavedVehicle() {
  const cfg = useProject((s) => s.project.vehicle);
  const setup = vehicleSetup.use();
  const { lites } = useLites();
  const tpl = useMemo(() => (cfg ? baseTemplate(cfg.templateId, setup.customSlots) : undefined), [cfg, setup.customSlots]);
  const eff = useMemo(() => (tpl && cfg ? effectiveTemplate(tpl, setup.tweaks, cfg.bindings) : undefined), [tpl, cfg, setup.tweaks]);
  const statuses = useMemo<Record<string, SlotStatus>>(() => (eff && cfg ? slotStatuses(eff, cfg.bindings, lites) : {}), [eff, cfg, lites]);
  return { cfg, setup, tpl: eff, statuses };
}

export interface SignalRef {
  uid48: string;
  key: string;
}

export const sigKey = (uid48: string, key: string): string => `${uid48}|${key}`;

/**
 * Many live signals at once (the live view watches every slot). The hub already limits
 * updates to its tick; a change of any watched value re-renders once.
 */
export function useSignalMap(refs: readonly SignalRef[]): ReadonlyMap<string, number> {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const sig = refs.map((r) => sigKey(r.uid48, r.key)).join(',');
  useEffect(() => {
    const offs = refs.map((r) => signalHub.subscribe(r.uid48, r.key, bump));
    return () => {
      for (const off of offs) off();
    };
    // `sig` identifies the set of refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const out = new Map<string, number>();
  for (const r of refs) out.set(sigKey(r.uid48, r.key), signalHub.read(r.uid48, r.key));
  return out;
}
