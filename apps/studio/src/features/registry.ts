import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { CarFront, ChartSpline, Cpu, FolderKanban, HardDriveDownload, Layers, Network, ScrollText, SlidersHorizontal } from 'lucide-react';
import type { IconComponent } from '../ui';
import type { NavParams } from '../app/nav';
// The nav label must exist before the (lazy) screen loads.
import { tVehicle } from './vehicle/messages';

export type FeatureId = 'bus' | 'vehicle' | 'device' | 'tuner' | 'scope' | 'canmon' | 'firmware' | 'project' | 'gallery';

/** Props every screen receives from the shell. */
export interface FeatureProps {
  /** Parameters from the URL hash, e.g. `{ device: 'esc80-3' }`. */
  params: NavParams;
}

export interface FeatureDef {
  id: FeatureId;
  /** Global i18n key for the navigation label. */
  labelKey: string;
  icon: IconComponent;
  component: LazyExoticComponent<ComponentType<FeatureProps>>;
  /** Position in the navigation rail. */
  order: number;
  /** Reachable by URL only (developer pages). */
  hidden?: boolean;
}

/**
 * All screens. Each lives in `src/features/<id>/` and is code-split, so a
 * screen's dictionary and heavy dependencies load only when visited.
 */
export const FEATURES: readonly FeatureDef[] = [
  { id: 'bus', labelKey: 'nav.bus', icon: Network, order: 10, component: lazy(() => import('./bus').then((m) => ({ default: m.BusScreen }))) },
  { id: 'vehicle', labelKey: tVehicle.key('nav'), icon: CarFront, order: 15, component: lazy(() => import('./vehicle').then((m) => ({ default: m.VehicleScreen }))) },
  { id: 'device', labelKey: 'nav.device', icon: Cpu, order: 20, component: lazy(() => import('./device').then((m) => ({ default: m.DeviceScreen }))) },
  { id: 'tuner', labelKey: 'nav.tuner', icon: SlidersHorizontal, order: 30, component: lazy(() => import('./tuner').then((m) => ({ default: m.TunerScreen }))) },
  { id: 'scope', labelKey: 'nav.scope', icon: ChartSpline, order: 40, component: lazy(() => import('./scope').then((m) => ({ default: m.ScopeScreen }))) },
  { id: 'canmon', labelKey: 'nav.canmon', icon: ScrollText, order: 50, component: lazy(() => import('./canmon').then((m) => ({ default: m.CanMonitorScreen }))) },
  { id: 'firmware', labelKey: 'nav.firmware', icon: HardDriveDownload, order: 60, component: lazy(() => import('./firmware').then((m) => ({ default: m.FirmwareScreen }))) },
  { id: 'project', labelKey: 'nav.project', icon: FolderKanban, order: 70, component: lazy(() => import('./project').then((m) => ({ default: m.ProjectScreen }))) },
  { id: 'gallery', labelKey: 'nav.gallery', icon: Layers, order: 1000, hidden: true, component: lazy(() => import('./gallery').then((m) => ({ default: m.GalleryScreen }))) },
];

export function findFeature(id: string): FeatureDef | undefined {
  return FEATURES.find((f) => f.id === id);
}

/** Features shown in the navigation rail, in order. */
export function navFeatures(): FeatureDef[] {
  return FEATURES.filter((f) => !f.hidden).sort((a, b) => a.order - b.order);
}
