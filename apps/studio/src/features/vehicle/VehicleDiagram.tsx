import {
  memo,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Bone,
  Cog,
  Compass,
  Cpu,
  Fan,
  Gauge,
  Hand,
  Monitor,
  MoveHorizontal,
  MoveVertical,
  Plus,
  RotateCw,
  Spline,
  Waves,
  Zap,
} from "lucide-react";
import type { SlotRole, VehicleSlot, VehicleTemplate } from "@cygnus/vehicles";
import { useI18n } from "../../i18n";
import { cx, type IconComponent } from "../../ui";
import type { SlotStatus } from "./model";
import { tVehicle } from "./messages";

export const ROLE_ICON: Record<SlotRole, IconComponent> = {
  drive: Cog,
  steer: RotateCw,
  thruster: Waves,
  propeller: Fan,
  joint: Bone,
  pan: MoveHorizontal,
  tilt: MoveVertical,
  surface: Spline,
  gripper: Hand,
  aux: Plus,
  steerEncoder: Gauge,
  jointEncoder: Gauge,
  encoder: Gauge,
  gyro: Compass,
  power: Zap,
  computePower: Cpu,
  display: Monitor,
};

/** Live values drawn on a slot (all optional). */
export interface SlotLive {
  /** Actuator output −1..1: arrow length, direction and colour. */
  output?: number;
  /** Extra rotation of the wheel / thrust arrow (swerve module angle), degrees clockwise. */
  angleDeg?: number;
  /** Encoder dial angle, degrees clockwise. */
  dialDeg?: number;
  /** Short value text shown under the slot instead of the role name. */
  value?: string;
}

export interface VehicleDiagramProps {
  template: VehicleTemplate;
  statuses?: Readonly<Record<string, SlotStatus>>;
  selected?: string | null;
  /** Slot the sequential assignment is waiting for. */
  highlight?: string | null;
  /** Number shown in the slot badge (default: suggested number). */
  numbers?: Readonly<Record<string, number | undefined>>;
  live?: Readonly<Record<string, SlotLive>>;
  /** Vehicle yaw (gyro), degrees clockwise: the body turns inside a fixed compass ring. */
  yawDeg?: number;
  /** Small preview: no labels, no badges. */
  compact?: boolean;
  onSlotClick?: (slotId: string) => void;
  /** HTML drag-and-drop of a board (uid48) onto a slot. */
  onSlotDrop?: (slotId: string, uid48: string) => void;
  /** Slots can be dragged to a new position (empty template editor). */
  onSlotMove?: (slotId: string, pos: { x: number; y: number }) => void;
  className?: string;
  ariaLabel?: string;
}

export const DRAG_MIME = "application/x-cygnus-uid";

const U = 190;
const R = 15;

interface Geom {
  m: number;
  hx: number;
  hy: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  px: (p: { x: number; y: number }) => { x: number; y: number };
}

/** Margins leave room for labels, arrows and the compass ring; previews crop tighter. */
function geometry(tpl: VehicleTemplate, compact: boolean): Geom {
  const m = compact ? 18 : 50;
  const nose = compact ? 10 : 22;
  const hx = U * Math.max(tpl.size.w, 0.8);
  const hy = U * Math.max(tpl.size.h, 0.8);
  const cx = m + hx;
  const cy = m + nose + hy;
  return {
    m,
    hx,
    hy,
    cx,
    cy,
    w: 2 * (m + hx),
    h: 2 * (m + hy) + nose,
    px: (p) => ({ x: cx + p.x * hx, y: cy - p.y * hy }),
  };
}

/** Unit vector of a heading (0 = nose, clockwise) in screen coordinates. */
const dir = (deg: number): { x: number; y: number } => {
  const a = (deg * Math.PI) / 180;
  return { x: Math.sin(a), y: -Math.cos(a) };
};

const isMulti = (s: VehicleTemplate["shape"]): boolean =>
  s === "x-frame" ||
  s === "plus-frame" ||
  s === "hexa-frame" ||
  s === "octo-frame";

/** Propeller disc radius: as large as fits between neighbouring propellers. */
function propRadius(tpl: VehicleTemplate, g: Geom): number {
  const props = tpl.slots
    .filter((s) => s.role === "propeller")
    .map((s) => g.px(s.pos));
  let min = Infinity;
  for (let i = 0; i < props.length; i++)
    for (let j = i + 1; j < props.length; j++) {
      const a = props[i]!;
      const b = props[j]!;
      min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y));
    }
  return Math.min(
    Number.isFinite(min) ? min * 0.46 : 60,
    0.42 * Math.min(g.hx, g.hy),
  );
}

function Body({ tpl, g }: { tpl: VehicleTemplate; g: Geom }) {
  const { cx, cy, hx, hy, px } = g;
  const shape = tpl.shape;
  if (shape === "rect") {
    return (
      <g className="vd-body">
        <rect
          className="vd-frame"
          x={cx - 0.86 * hx}
          y={cy - 0.86 * hy}
          width={1.72 * hx}
          height={1.72 * hy}
          rx={16}
        />
        <rect
          className="vd-bumper"
          x={cx - 0.92 * hx}
          y={cy - 0.92 * hy}
          width={1.84 * hx}
          height={1.84 * hy}
          rx={20}
        />
        <line
          className="vd-member"
          x1={cx - 0.86 * hx}
          y1={cy}
          x2={cx + 0.86 * hx}
          y2={cy}
        />
      </g>
    );
  }
  if (isMulti(shape)) {
    const props = tpl.slots.filter((s) => s.role === "propeller");
    const plate = 0.26 * Math.min(hx, hy);
    return (
      <g className="vd-body">
        {props.map((s) => {
          const p = px(s.pos);
          return (
            <line
              key={s.id}
              className="vd-arm"
              x1={cx}
              y1={cy}
              x2={p.x}
              y2={p.y}
            />
          );
        })}
        {shape === "hexa-frame" || shape === "octo-frame" ? (
          <circle className="vd-frame" cx={cx} cy={cy} r={plate * 1.15} />
        ) : (
          <rect
            className="vd-frame"
            x={cx - plate}
            y={cy - plate}
            width={2 * plate}
            height={2 * plate}
            rx={14}
            transform={
              shape === "plus-frame" ? `rotate(45 ${cx} ${cy})` : undefined
            }
          />
        )}
      </g>
    );
  }
  if (shape === "plane") {
    const fx = 0.09 * hx;
    const wing = `M ${cx - 0.1 * hx} ${cy - 0.24 * hy} L ${cx - 0.98 * hx} ${cy - 0.12 * hy} L ${cx - 0.98 * hx} ${cy + 0.02 * hy} L ${cx - 0.1 * hx} ${cy + 0.06 * hy}
      L ${cx + 0.1 * hx} ${cy + 0.06 * hy} L ${cx + 0.98 * hx} ${cy + 0.02 * hy} L ${cx + 0.98 * hx} ${cy - 0.12 * hy} L ${cx + 0.1 * hx} ${cy - 0.24 * hy} Z`;
    const tail = `M ${cx - 0.05 * hx} ${cy + 0.6 * hy} L ${cx - 0.36 * hx} ${cy + 0.68 * hy} L ${cx - 0.36 * hx} ${cy + 0.78 * hy} L ${cx + 0.36 * hx} ${cy + 0.78 * hy} L ${cx + 0.36 * hx} ${cy + 0.68 * hy} L ${cx + 0.05 * hx} ${cy + 0.6 * hy} Z`;
    return (
      <g className="vd-body">
        <path className="vd-frame" d={wing} />
        <path className="vd-frame" d={tail} />
        <rect
          className="vd-frame vd-fuselage"
          x={cx - fx}
          y={cy - 0.86 * hy}
          width={2 * fx}
          height={1.82 * hy}
          rx={fx}
        />
        <line
          className="vd-member"
          x1={cx}
          y1={cy + 0.62 * hy}
          x2={cx}
          y2={cy + 0.96 * hy}
        />
      </g>
    );
  }
  if (shape === "rov") {
    const x0 = cx - 0.9 * hx;
    const x1 = cx + 0.9 * hx;
    const y0 = cy - 0.9 * hy;
    const y1 = cy + 0.9 * hy;
    return (
      <g className="vd-body">
        <rect
          className="vd-frame"
          x={x0}
          y={y0}
          width={x1 - x0}
          height={y1 - y0}
          rx={10}
        />
        <line className="vd-rail" x1={x0} y1={y0} x2={x0} y2={y1} />
        <line className="vd-rail" x1={x1} y1={y0} x2={x1} y2={y1} />
        <line className="vd-member" x1={x0} y1={cy} x2={x1} y2={cy} />
        <line className="vd-member" x1={cx} y1={y0} x2={cx} y2={y1} />
      </g>
    );
  }
  if (shape === "hull") {
    const d = `M ${cx} ${cy - 0.98 * hy} C ${cx + 0.55 * hx} ${cy - 0.75 * hy}, ${cx + 0.86 * hx} ${cy - 0.35 * hy}, ${cx + 0.86 * hx} ${cy + 0.1 * hy}
      L ${cx + 0.8 * hx} ${cy + 0.92 * hy} L ${cx - 0.8 * hx} ${cy + 0.92 * hy} L ${cx - 0.86 * hx} ${cy + 0.1 * hy}
      C ${cx - 0.86 * hx} ${cy - 0.35 * hy}, ${cx - 0.55 * hx} ${cy - 0.75 * hy}, ${cx} ${cy - 0.98 * hy} Z`;
    return (
      <g className="vd-body">
        <path className="vd-frame" d={d} />
        <line
          className="vd-member"
          x1={cx}
          y1={cy - 0.85 * hy}
          x2={cx}
          y2={cy + 0.85 * hy}
        />
      </g>
    );
  }
  if (shape === "turret") {
    const r = 0.82 * Math.min(hx, hy);
    return (
      <g className="vd-body">
        <circle className="vd-frame" cx={cx} cy={cy} r={r} />
        <circle className="vd-member vd-dashed" cx={cx} cy={cy} r={r * 0.62} />
        <rect
          className="vd-frame"
          x={cx - 0.08 * hx}
          y={cy - 0.98 * hy}
          width={0.16 * hx}
          height={0.98 * hy}
          rx={6}
        />
      </g>
    );
  }
  if (shape === "arm") {
    const joints = tpl.slots
      .filter((s) => s.role === "joint")
      .map((s) => px(s.pos));
    const grip = tpl.slots.find((s) => s.role === "gripper");
    const pts = [
      { x: cx, y: cy + 0.98 * hy },
      ...joints.sort((a, b) => b.y - a.y),
      ...(grip ? [px(grip.pos)] : []),
    ];
    const top = pts[pts.length - 1]!;
    return (
      <g className="vd-body">
        <path
          className="vd-frame"
          d={`M ${cx - 0.7 * hx} ${cy + 0.98 * hy} L ${cx - 0.45 * hx} ${cy + 0.88 * hy} L ${cx + 0.45 * hx} ${cy + 0.88 * hy} L ${cx + 0.7 * hx} ${cy + 0.98 * hy} Z`}
        />
        <polyline
          className="vd-link"
          points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
        />
        <path
          className="vd-claw"
          d={`M ${top.x - 18} ${top.y - 30} L ${top.x - 18} ${top.y - 18} L ${top.x + 18} ${top.y - 18} L ${top.x + 18} ${top.y - 30}`}
        />
      </g>
    );
  }
  // free
  return (
    <g className="vd-body">
      {[-0.5, 0, 0.5].map((k) => (
        <g key={k}>
          <line
            className="vd-grid"
            x1={cx + k * hx}
            y1={cy - hy}
            x2={cx + k * hx}
            y2={cy + hy}
          />
          <line
            className="vd-grid"
            x1={cx - hx}
            y1={cy + k * hy}
            x2={cx + hx}
            y2={cy + k * hy}
          />
        </g>
      ))}
      <rect
        className="vd-frame vd-dashed"
        x={cx - hx}
        y={cy - hy}
        width={2 * hx}
        height={2 * hy}
        rx={12}
      />
    </g>
  );
}

interface LabelPos {
  x: number;
  y: number;
  anchor: "middle" | "start" | "end";
}

type Box = [number, number, number, number]; // x0 y0 x1 y1
const hit = (a: Box, b: Box): boolean =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * Puts each slot label below its marker unless that covers another marker, wheel or label;
 * then tries above, right and left. Positions are relative to the marker centre.
 */
function placeLabels(
  slots: readonly VehicleSlot[],
  g: Geom,
  text: (s: VehicleSlot) => string,
): Record<string, LabelPos> {
  const pts = slots.map((s) => ({ s, p: g.px(s.pos) }));
  const obstacles: Array<{ id: string; box: Box }> = pts.flatMap(({ s, p }) => {
    const out: Array<{ id: string; box: Box }> = [
      { id: s.id, box: [p.x - R - 2, p.y - R - 2, p.x + R + 2, p.y + R + 2] },
    ];
    if (s.role === "drive")
      out.push({ id: s.id, box: [p.x - 11, p.y - 25, p.x + 11, p.y + 25] });
    return out;
  });
  const placed: Box[] = [];
  const out: Record<string, LabelPos> = {};
  for (const { s, p } of pts) {
    const w = text(s).length * 5.9 + 4;
    const cands: Array<{ pos: LabelPos; box: Box }> = [
      {
        pos: { x: 0, y: R + 13, anchor: "middle" },
        box: [p.x - w / 2, p.y + R + 3, p.x + w / 2, p.y + R + 15],
      },
      {
        pos: { x: 0, y: -R - 8, anchor: "middle" },
        box: [p.x - w / 2, p.y - R - 18, p.x + w / 2, p.y - R - 6],
      },
      {
        pos: { x: R + 5, y: 4, anchor: "start" },
        box: [p.x + R + 4, p.y - 6, p.x + R + 4 + w, p.y + 6],
      },
      {
        pos: { x: -R - 5, y: 4, anchor: "end" },
        box: [p.x - R - 4 - w, p.y - 6, p.x - R - 4, p.y + 6],
      },
    ];
    const free =
      cands.find(
        (c) =>
          !obstacles.some((o) => o.id !== s.id && hit(o.box, c.box)) &&
          !placed.some((b) => hit(b, c.box)),
      ) ?? cands[0]!;
    placed.push(free.box);
    out[s.id] = free.pos;
  }
  return out;
}

/** Module clusters (e.g. a swerve module: drive + steer + encoder). */
function Groups({
  tpl,
  g,
  lang,
  titles,
}: {
  tpl: VehicleTemplate;
  g: Geom;
  lang: "tr" | "en";
  titles: boolean;
}) {
  const groups = new Map<string, VehicleSlot[]>();
  for (const s of tpl.slots)
    if (s.group) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  return (
    <g className="vd-groups">
      {[...groups.entries()]
        .filter(([, slots]) => slots.length > 1)
        .map(([id, slots]) => {
          const pts = slots.map((s) => g.px(s.pos));
          const pad = R + 9;
          const x0 = Math.min(...pts.map((p) => p.x)) - pad;
          const x1 = Math.max(...pts.map((p) => p.x)) + pad;
          const y0 = Math.min(...pts.map((p) => p.y)) - pad;
          const y1 = Math.max(...pts.map((p) => p.y)) + pad + 12;
          const prefixes = new Set(
            slots.map((s) => s.label[lang].split(" · ")[0]),
          );
          const title = titles && prefixes.size === 1 ? [...prefixes][0] : null;
          return (
            <g key={id} className="vd-group">
              <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} rx={14} />
              {title && (
                // On the side facing the vehicle centre, where the frame leaves room.
                <text
                  x={x0 + 8}
                  y={(y0 + y1) / 2 < g.cy ? y1 + 13 : y0 - 6}
                  className="vd-group__title"
                >
                  {title}
                </text>
              )}
            </g>
          );
        })}
    </g>
  );
}

function Arrow({ len, cls }: { len: number; cls: string }) {
  // Pointing up (−y) from the origin; the caller rotates it.
  const head = Math.min(8, Math.max(5, len * 0.35));
  return (
    <g className={cls}>
      <line x1={0} y1={0} x2={0} y2={-len + head * 0.6} />
      <path
        d={`M 0 ${-len} L ${-head * 0.7} ${-len + head} L ${head * 0.7} ${-len + head} Z`}
      />
    </g>
  );
}

function SpinArc({ spin, r }: { spin: "cw" | "ccw"; r: number }) {
  // A 250° arc around the marker with the head at its end, in the turning direction.
  const a0 = spin === "cw" ? -200 : 20;
  const a1 = spin === "cw" ? 20 : -200;
  const pt = (deg: number) => ({
    x: r * Math.cos((deg * Math.PI) / 180),
    y: r * Math.sin((deg * Math.PI) / 180),
  });
  const p0 = pt(a0);
  const p1 = pt(a1);
  const sweep = spin === "cw" ? 1 : 0;
  // Tangent direction at the end of the arc.
  const t = ((a1 + (spin === "cw" ? 90 : -90)) * Math.PI) / 180;
  const tx = Math.cos(t);
  const ty = Math.sin(t);
  const nx = -ty;
  const ny = tx;
  const hl = 7;
  const head = `M ${p1.x + tx * hl} ${p1.y + ty * hl} L ${p1.x + nx * 4.5} ${p1.y + ny * 4.5} L ${p1.x - nx * 4.5} ${p1.y - ny * 4.5} Z`;
  return (
    <g className={`vd-spin vd-spin--${spin}`}>
      <path d={`M ${p0.x} ${p0.y} A ${r} ${r} 0 1 ${sweep} ${p1.x} ${p1.y}`} />
      <path className="vd-spin__head" d={head} />
    </g>
  );
}

interface SlotProps {
  slot: VehicleSlot;
  x: number;
  y: number;
  status: SlotStatus;
  selected: boolean;
  highlight: boolean;
  num: number | undefined;
  live: SlotLive | undefined;
  compact: boolean;
  propR: number;
  yaw: number;
  label: string;
  labelPos: LabelPos | undefined;
  title: string;
  interactive: boolean;
  movable: boolean;
  dropTarget: boolean;
  onClick?: (id: string) => void;
  onDrop?: (id: string, uid: string) => void;
  onPointerDown?: (id: string, e: ReactPointerEvent<SVGGElement>) => void;
  onDragState: (id: string | null) => void;
}

const SlotMark = memo(function SlotMark(p: SlotProps) {
  const { slot } = p;
  const Icon = ROLE_ICON[slot.role];
  const hasHeading =
    slot.headingDeg !== undefined &&
    (slot.role === "drive" ||
      slot.role === "thruster" ||
      slot.role === "steer");
  const out = p.live?.output;
  const heading = (slot.headingDeg ?? 0) + (p.live?.angleDeg ?? 0);
  const wheel = slot.role === "drive";
  const duct = slot.role === "thruster" && slot.headingDeg !== undefined;
  const liveArrow = out !== undefined && Number.isFinite(out);
  const arrowLen = liveArrow ? 8 + Math.min(1, Math.abs(out)) * 34 : 22;
  const arrowDeg = liveArrow && out < 0 ? heading + 180 : heading;
  const arrowCls = liveArrow
    ? cx(
        "vd-arrow",
        Math.abs(out) > 0.6
          ? "is-high"
          : Math.abs(out) > 0.02
            ? "is-live"
            : "is-idle",
      )
    : "vd-arrow";
  const drop = p.onDrop
    ? {
        onDragOver: (e: DragEvent<SVGGElement>) => {
          if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "link";
          p.onDragState(slot.id);
        },
        onDragLeave: () => p.onDragState(null),
        onDrop: (e: DragEvent<SVGGElement>) => {
          e.preventDefault();
          p.onDragState(null);
          const uid = e.dataTransfer.getData(DRAG_MIME);
          if (uid) p.onDrop?.(slot.id, uid);
        },
      }
    : {};
  return (
    <g
      className={cx(
        "vd-slot",
        `is-${p.status}`,
        p.selected && "is-selected",
        p.highlight && "is-highlight",
        p.dropTarget && "is-drop",
        p.interactive && "is-interactive",
        p.movable && "is-movable",
      )}
      transform={`translate(${p.x} ${p.y})`}
      data-slot={slot.id}
      role={p.interactive ? "button" : undefined}
      tabIndex={p.interactive ? 0 : undefined}
      aria-label={p.interactive ? p.title : undefined}
      aria-pressed={p.interactive ? p.selected : undefined}
      onClick={p.onClick ? () => p.onClick?.(slot.id) : undefined}
      onKeyDown={
        p.onClick
          ? (e) => {
              if (e.key === "Enter") p.onClick?.(slot.id);
            }
          : undefined
      }
      onPointerDown={
        p.onPointerDown ? (e) => p.onPointerDown?.(slot.id, e) : undefined
      }
      {...drop}
    >
      <title>{p.title}</title>
      {slot.role === "propeller" && <circle className="vd-prop" r={p.propR} />}
      {(wheel || duct) && (
        <g transform={`rotate(${heading})`}>
          {wheel ? (
            <rect
              className="vd-wheel"
              x={-10}
              y={-24}
              width={20}
              height={48}
              rx={6}
            />
          ) : (
            <rect
              className="vd-duct"
              x={-15}
              y={-22}
              width={30}
              height={44}
              rx={9}
            />
          )}
        </g>
      )}
      {slot.role === "thruster" && slot.headingDeg === undefined && (
        <circle className="vd-duct" r={R + 6} />
      )}
      {hasHeading && (
        <g
          transform={`rotate(${arrowDeg}) translate(0 ${-(wheel ? 25 : R + 8)})`}
        >
          <Arrow len={arrowLen} cls={arrowCls} />
        </g>
      )}
      {slot.spin && !p.compact && <SpinArc spin={slot.spin} r={R + 8} />}
      {slot.spin && p.compact && <SpinArc spin={slot.spin} r={R + 6} />}
      {liveArrow && !hasHeading && (
        <circle
          className={cx("vd-ring", Math.abs(out) > 0.02 && "is-live")}
          r={R + 4}
          strokeDasharray={`${Math.min(1, Math.abs(out)) * 2 * Math.PI * (R + 4)} 999`}
          transform="rotate(-90)"
        />
      )}
      <g transform={p.yaw ? `rotate(${-p.yaw})` : undefined}>
        {p.selected && <circle className="vd-slot__sel" r={R + 6} />}
        {p.highlight && <circle className="vd-slot__pulse" r={R + 6} />}
        <circle className="vd-slot__dot" r={R} />
        {p.live?.dialDeg !== undefined && Number.isFinite(p.live.dialDeg) ? (
          <g className="vd-dial" transform={`rotate(${p.live.dialDeg})`}>
            <line x1={0} y1={4} x2={0} y2={-R + 3} />
            <circle r={2.5} />
          </g>
        ) : (
          <Icon
            x={-8}
            y={-8}
            width={16}
            height={16}
            strokeWidth={2}
            className="vd-slot__icon"
            aria-hidden
          />
        )}
        {!p.compact && p.num !== undefined && (
          <g
            className="vd-slot__num"
            transform={`translate(${R * 0.78} ${-R * 0.78})`}
          >
            <circle r={7.5} />
            <text y={3}>{p.num}</text>
          </g>
        )}
        {!p.compact && (
          <text
            className={cx(
              "vd-slot__label",
              p.live?.value !== undefined && "is-value",
            )}
            x={p.labelPos?.x ?? 0}
            y={p.labelPos?.y ?? R + 13}
            textAnchor={p.labelPos?.anchor ?? "middle"}
          >
            {p.live?.value ?? p.label}
          </text>
        )}
      </g>
    </g>
  );
});

/**
 * Parametric vehicle diagram: body by `shape`, slots at their positions with role icons,
 * wheel/thrust arrows (`headingDeg`), propeller spin arrows, module groups and the nose marker.
 * Used for gallery previews, the assignment step and the live view.
 */
export function VehicleDiagram({
  template,
  statuses,
  selected = null,
  highlight = null,
  numbers,
  live,
  yawDeg,
  compact = false,
  onSlotClick,
  onSlotDrop,
  onSlotMove,
  className,
  ariaLabel,
}: VehicleDiagramProps) {
  const { lang, tl } = useI18n();
  const g = useMemo(() => geometry(template, compact), [template, compact]);
  const propR = useMemo(() => propRadius(template, g), [template, g]);
  const labels = useMemo(
    () =>
      compact
        ? {}
        : placeLabels(template.slots, g, (s) =>
            tVehicle(`roleShort.${s.role}`),
          ),
    [template, g, compact, lang],
  );
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [moving, setMoving] = useState<{
    id: string;
    pos: { x: number; y: number };
  } | null>(null);
  const yaw = yawDeg !== undefined && Number.isFinite(yawDeg) ? yawDeg : 0;
  const compass = yawDeg !== undefined;

  const toPos = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return null;
    const pt = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return {
      x: Math.max(-1, Math.min(1, (pt.x - g.cx) / g.hx)),
      y: Math.max(-1, Math.min(1, (g.cy - pt.y) / g.hy)),
    };
  };

  const onPointerDown = onSlotMove
    ? (id: string, e: ReactPointerEvent<SVGGElement>) => {
        if (e.button !== 0) return;
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        const slot = template.slots.find((s) => s.id === id);
        if (slot) setMoving({ id, pos: slot.pos });
      }
    : undefined;

  const slots = moving
    ? template.slots.map((s) =>
        s.id === moving.id ? { ...s, pos: moving.pos } : s,
      )
    : template.slots;
  const shown = moving ? { ...template, slots } : template;

  return (
    <svg
      ref={svgRef}
      className={cx("vd", compact && "vd--compact", className)}
      viewBox={`0 0 ${g.w} ${g.h}`}
      role="img"
      aria-label={ariaLabel ?? tl(template.name)}
      onPointerMove={
        moving
          ? (e) => {
              const p = toPos(e.clientX, e.clientY);
              if (p) setMoving({ id: moving.id, pos: p });
            }
          : undefined
      }
      onPointerUp={
        moving
          ? () => {
              onSlotMove?.(moving.id, moving.pos);
              setMoving(null);
            }
          : undefined
      }
    >
      {compass && (
        <g className="vd-compass">
          <circle cx={g.cx} cy={g.cy} r={Math.min(g.hx, g.hy) + g.m * 0.55} />
          {(["N", "E", "S", "W"] as const).map((k, i) => {
            const d = dir(i * 90);
            const r = Math.min(g.hx, g.hy) + g.m * 0.55;
            return (
              <text key={k} x={g.cx + d.x * r} y={g.cy + d.y * r + 4}>
                {tVehicle(`compass.${k}`)}
              </text>
            );
          })}
        </g>
      )}
      <g transform={yaw ? `rotate(${yaw} ${g.cx} ${g.cy})` : undefined}>
        <g
          className="vd-nose"
          transform={`translate(${g.cx} ${g.m * 0.5 + (compact ? 4 : 0)})`}
        >
          <path d="M 0 -8 L 9 6 L -9 6 Z" />
          {!compact && !compass && <text y={20}>{tVehicle("nose")}</text>}
        </g>
        <Body tpl={shown} g={g} />
        <Groups tpl={shown} g={g} lang={lang} titles={!compact} />
        {slots.map((s) => {
          const p = g.px(s.pos);
          return (
            <SlotMark
              key={s.id}
              slot={s}
              x={p.x}
              y={p.y}
              status={statuses?.[s.id] ?? "empty"}
              selected={selected === s.id}
              highlight={highlight === s.id}
              num={numbers ? numbers[s.id] : s.suggestedNum}
              live={live?.[s.id]}
              compact={compact}
              propR={propR}
              yaw={yaw}
              label={tVehicle(`roleShort.${s.role}`)}
              labelPos={labels[s.id]}
              title={`${tl(s.label)}${s.required ? "" : ` (${tVehicle("optional")})`}`}
              interactive={!!onSlotClick}
              movable={!!onSlotMove}
              dropTarget={dragOver === s.id}
              onClick={onSlotClick}
              onDrop={onSlotDrop}
              onPointerDown={onPointerDown}
              onDragState={setDragOver}
            />
          );
        })}
      </g>
    </svg>
  );
}
