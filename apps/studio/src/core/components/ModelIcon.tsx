import { BatteryCharging, Compass, Cpu, Disc3, Droplets, Fan, Monitor, SlidersVertical, Usb, Zap } from 'lucide-react';
import type { ModelCategory, ModelDef } from '@cygnus/protocol';
import { cx, type IconComponent } from '../../ui';

const BY_KEY: Record<string, IconComponent> = {
  esc20a: Fan,
  esc80a: Fan,
  cyncoder: Disc3,
  cyncoder_v3: Disc3,
  gyro: Compass,
  servo16: SlidersVertical,
  sealed_servo: Droplets,
  pdh_small: Zap,
  pdh_large: Zap,
  soc_reg: BatteryCharging,
  oled: Monitor,
  usbcan: Usb,
};

const BY_CATEGORY: Record<ModelCategory, IconComponent> = { motor: Fan, sensor: Compass, servo: SlidersVertical, power: Zap, tool: Monitor };

export function modelIcon(def: Pick<ModelDef, 'key' | 'category'> | undefined): IconComponent {
  if (!def) return Cpu;
  return BY_KEY[def.key] ?? BY_CATEGORY[def.category] ?? Cpu;
}

export interface ModelIconProps {
  def: Pick<ModelDef, 'key' | 'category'> | undefined;
  /** Icon size in px (default 18). */
  size?: number;
  /** Rounded tinted square behind the icon (cards, headers). */
  boxed?: boolean;
  className?: string;
}

/** Product icon by catalog model (category fallback for unknown models). */
export function ModelIcon({ def, size = 18, boxed, className }: ModelIconProps) {
  const Icon = modelIcon(def);
  const icon = <Icon size={size} strokeWidth={1.9} aria-hidden />;
  if (!boxed) return icon;
  return (
    <span className={cx('cy-model-icon', def && `cy-model-icon--${def.category}`, className)} style={{ width: size + 16, height: size + 16 }}>
      {icon}
    </span>
  );
}
