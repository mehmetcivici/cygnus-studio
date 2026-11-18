export type LocalizedText = { tr: string; en: string };

export type SlotRole =
  | 'drive' | 'steer' | 'thruster' | 'propeller' | 'joint' | 'pan' | 'tilt' | 'surface' | 'gripper' | 'aux' // actuators
  | 'steerEncoder' | 'jointEncoder' | 'encoder' | 'gyro'                                                    // sensors
  | 'power' | 'computePower' | 'display';                                                                   // infrastructure

/** Catalog model key (ModelDef.key). `channel`: a single channel of the 16-channel servo board. */
export interface SlotAccept { model: string; via: 'device' | 'channel' }

export interface VehicleSlot {
  id: string;
  role: SlotRole;
  label: LocalizedText;
  group?: string;
  accepts: SlotAccept[];
  required: boolean;
  /** Diagram coordinate, −1..1; +x right, +y forward (nose up). */
  pos: { x: number; y: number };
  /** Thrust / wheel direction arrow (0 = forward, clockwise positive). */
  headingDeg?: number;
  spin?: 'cw' | 'ccw';
  suggestedNum?: number;
  /** Suggested parameters on assignment (catalog param key → value). */
  presets?: Record<string, number>;
}

export interface VehicleTemplate {
  id: string;
  category: 'frc' | 'ground' | 'air' | 'underwater' | 'surface' | 'defense' | 'arm' | 'custom';
  name: LocalizedText;
  description: LocalizedText;
  competitions: string[];
  shape: 'rect' | 'x-frame' | 'plus-frame' | 'hexa-frame' | 'octo-frame' | 'plane' | 'rov' | 'hull' | 'turret' | 'arm' | 'free';
  size: { w: number; h: number };
  slots: VehicleSlot[];
}

export type SlotBinding =
  | { kind: 'device'; uid48: string; model: string }
  | { kind: 'channel'; uid48: string; model: string; channel: number }
  | { kind: 'external'; canId?: number; note: string };

export interface VehicleConfig {
  templateId: string;
  name: string;
  bindings: Record<string, SlotBinding>;
}
