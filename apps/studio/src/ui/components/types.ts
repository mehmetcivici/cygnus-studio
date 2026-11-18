import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';

/** Icon component (lucide-react or compatible). Pass the component, not an element: `icon={Play}`. */
export type IconComponent = ComponentType<LucideProps>;

export type ControlSize = 'sm' | 'md' | 'lg';

/** Semantic tone shared by badges, meters, tiles and toasts. */
export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'caution' | 'danger';

/** Device / link health state used by StatusDot and friends. */
export type DeviceStatus = 'ok' | 'warn' | 'fault' | 'offline' | 'boot';

export const ICON_SIZE: Record<ControlSize, number> = { sm: 14, md: 16, lg: 18 };

/** Joins truthy class names. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
