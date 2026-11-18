import { useEffect, useMemo, useState } from "react";
import {
  CarFront,
  CircleCheck,
  Cpu,
  Settings2,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type {
  SlotBinding,
  VehicleConfig,
  VehicleSlot,
  VehicleTemplate,
} from "@cygnus/vehicles";
import {
  DeviceBadge,
  SignalTile,
  primarySignals,
  setVehicleConfig,
  useConnection,
  useDevice,
} from "../../core";
import { navigate } from "../../app/nav";
import { useI18n } from "../../i18n";
import {
  Badge,
  Button,
  ConfirmDialog,
  Page,
  Panel,
  StatTile,
  cx,
  toast,
} from "../../ui";
import { isActuator, isEncoder, type SlotStatus } from "./model";
import { sigKey, useSignalMap, useSavedVehicle, type SignalRef } from "./hooks";
import { vehicleSetup } from "./project";
import { draft } from "./store";
import { BindingText, StatusBadge } from "./SlotInspector";
import { Legend } from "./StepAssign";
import { VehicleDiagram, type SlotLive } from "./VehicleDiagram";
import { tVehicle } from "./messages";

function signalsFor(b: SlotBinding): string[] {
  if (b.kind === "external") return [];
  if (b.kind === "channel") return [`ch.${b.channel}.pulse`];
  switch (b.model) {
    case "esc20a":
    case "esc80a":
      return ["duty", "velocity", "bus.current"];
    case "sealed_servo":
      return ["output", "position", "current"];
    case "cyncoder":
      return ["abs.position"];
    case "gyro":
      return ["yaw", "pitch", "roll"];
    case "pdh_small":
    case "pdh_large":
      return ["input.voltage", "total.current"];
    case "soc_reg":
      return ["output.voltage", "output.current"];
    default:
      return [];
  }
}

const wrap360 = (d: number): number => ((d % 360) + 360) % 360;

function liveFor(
  slot: VehicleSlot,
  b: SlotBinding | undefined,
  v: (key: string) => number,
  fmt: (x: number, d?: number) => string,
): SlotLive | undefined {
  if (!b || b.kind === "external") return undefined;
  if (b.kind === "channel") {
    const p = v(`ch.${b.channel}.pulse`);
    if (!Number.isFinite(p)) return undefined;
    const out =
      p <= 0
        ? 0
        : slot.role === "propeller"
          ? (p - 1000) / 1000
          : (p - 1500) / 400;
    return { output: out, value: `${fmt(p)} µs` };
  }
  switch (b.model) {
    case "esc20a":
    case "esc80a": {
      const rpm = v("velocity");
      return {
        output: v("duty"),
        value: Number.isFinite(rpm) ? `${fmt(rpm)} rpm` : undefined,
      };
    }
    case "sealed_servo": {
      const pos = v("position");
      return {
        output: v("output"),
        value: Number.isFinite(pos) ? `${fmt(pos)}°` : undefined,
      };
    }
    case "cyncoder": {
      const r = v("abs.position");
      return Number.isFinite(r)
        ? { dialDeg: wrap360(r * 360), value: `${fmt(wrap360(Math.round(r * 360)))}°` }
        : undefined;
    }
    case "gyro": {
      const y = v("yaw");
      return Number.isFinite(y)
        ? { dialDeg: y, value: `${fmt(y)}°` }
        : undefined;
    }
    case "pdh_small":
    case "pdh_large": {
      const a = v("total.current");
      return Number.isFinite(a) ? { value: `${fmt(a, 1)} A` } : undefined;
    }
    case "soc_reg": {
      const u = v("output.voltage");
      return Number.isFinite(u) ? { value: `${fmt(u, 1)} V` } : undefined;
    }
    default:
      return undefined;
  }
}

/** Pitch/roll indicator: a horizon line tilted by roll and shifted by pitch. */
function Attitude({ pitch, roll }: { pitch: number; roll: number }) {
  const ok = Number.isFinite(pitch) && Number.isFinite(roll);
  const p = ok ? Math.max(-40, Math.min(40, pitch)) : 0;
  const r = ok ? roll : 0;
  return (
    <svg
      className={cx("vh-att", !ok && "is-off")}
      viewBox="-50 -50 100 100"
      role="img"
      aria-label={tVehicle("live.attitude")}
    >
      <defs>
        <clipPath id="vh-att-clip">
          <circle r={44} />
        </clipPath>
      </defs>
      <g clipPath="url(#vh-att-clip)">
        <g transform={`rotate(${-r}) translate(0 ${p})`}>
          <rect
            className="vh-att__sky"
            x={-100}
            y={-100}
            width={200}
            height={100}
          />
          <rect
            className="vh-att__ground"
            x={-100}
            y={0}
            width={200}
            height={100}
          />
          <line className="vh-att__horizon" x1={-100} y1={0} x2={100} y2={0} />
          {[-20, -10, 10, 20].map((k) => (
            <line
              key={k}
              className="vh-att__tick"
              x1={-10}
              y1={k}
              x2={10}
              y2={k}
            />
          ))}
        </g>
      </g>
      <circle className="vh-att__rim" r={44} />
      <path className="vh-att__plane" d="M -22 0 L -7 0 L 0 6 L 7 0 L 22 0" />
    </svg>
  );
}

function SlotPanel({
  slot,
  binding,
  status,
}: {
  slot: VehicleSlot | null;
  binding: SlotBinding | undefined;
  status: SlotStatus | undefined;
}) {
  const { tl } = useI18n();
  const uid = binding && binding.kind !== "external" ? binding.uid48 : null;
  const view = useDevice(uid);
  const sigs = useMemo(() => {
    if (!binding || binding.kind === "external" || !view) return [];
    if (binding.kind === "channel")
      return [`ch.${binding.channel}.pulse`, "rail.voltage", "rail.current"];
    return [...primarySignals(view.def, 3)];
  }, [binding, view]);
  if (!slot) {
    return (
      <Panel title={tVehicle("live.slotPanel")}>
        <p className="vh-dim vh-small">{tVehicle("live.slotNone")}</p>
      </Panel>
    );
  }
  return (
    <Panel
      title={tl(slot.label)}
      subtitle={tVehicle(`role.${slot.role}`)}
      actions={status && <StatusBadge status={status} />}
      className="vh-live__slot"
    >
      <div className="vh-live__bind">
        {view ? (
          <DeviceBadge device={view} />
        ) : (
          <BindingText binding={binding} />
        )}
      </div>
      {binding?.kind === "channel" && (
        <p className="vh-small vh-dim">
          {tVehicle("slot.channel", {
            board: view?.name ?? "",
            ch: binding.channel,
          })}
        </p>
      )}
      {view && view.online && sigs.length > 0 && (
        <div className="vh-live__tiles">
          {sigs.map((k) => (
            <SignalTile key={k} uid48={view.uid48} signal={k} />
          ))}
        </div>
      )}
      {uid && (
        <div className="vh-test__row">
          <Button
            size="sm"
            icon={Cpu}
            onClick={() => navigate("device", { device: uid })}
          >
            {tVehicle("live.toDevice")}
          </Button>
          {isActuator(slot) && binding?.kind === "device" && (
            <Button
              size="sm"
              variant="ghost"
              icon={SlidersHorizontal}
              onClick={() => navigate("tuner", { device: uid })}
            >
              {tVehicle("live.toTuner")}
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

function Body({
  cfg,
  tpl,
  statuses,
}: {
  cfg: VehicleConfig;
  tpl: VehicleTemplate;
  statuses: Record<string, SlotStatus>;
}) {
  const { tl, fmtNumber } = useI18n();
  const phase = useConnection((s) => s.phase);
  const [sel, setSel] = useState<string | null>(null);
  const fmt = (x: number, d = 0): string => fmtNumber(x, d);

  const refs = useMemo<SignalRef[]>(() => {
    const out: SignalRef[] = [];
    for (const s of tpl.slots) {
      const b = cfg.bindings[s.id];
      if (!b || b.kind === "external") continue;
      for (const key of signalsFor(b)) out.push({ uid48: b.uid48, key });
    }
    return out;
  }, [tpl, cfg]);
  const values = useSignalMap(refs);

  const read =
    (b: SlotBinding | undefined) =>
    (key: string): number =>
      b && b.kind !== "external"
        ? (values.get(sigKey(b.uid48, key)) ?? NaN)
        : NaN;
  const live: Record<string, SlotLive> = {};
  const encAngle = new Map<string, number>();
  for (const s of tpl.slots) {
    const b = cfg.bindings[s.id];
    if (statuses[s.id] !== "online") continue;
    const l = liveFor(s, b, read(b), fmt);
    if (l) live[s.id] = l;
    if (s.group && isEncoder(s) && l?.dialDeg !== undefined)
      encAngle.set(s.group, l.dialDeg);
  }
  // Swerve: the wheel and its thrust arrow turn with the module's steer encoder.
  for (const s of tpl.slots) {
    if (s.role !== "drive" || !s.group) continue;
    const a = encAngle.get(s.group);
    if (a !== undefined) live[s.id] = { ...(live[s.id] ?? {}), angleDeg: a };
  }

  const gyroSlot = tpl.slots.find(
    (s) => s.role === "gyro" && statuses[s.id] === "online",
  );
  const gb = gyroSlot ? cfg.bindings[gyroSlot.id] : undefined;
  const yaw = read(gb)("yaw");
  const pitch = read(gb)("pitch");
  const roll = read(gb)("roll");
  const powerSlot = tpl.slots.find(
    (s) => s.role === "power" && statuses[s.id] === "online",
  );
  const pb = powerSlot ? cfg.bindings[powerSlot.id] : undefined;
  const volts = read(pb)("input.voltage");
  const amps = read(pb)("total.current");

  const warnings: Array<{ id: string; text: string; tone: "warn" | "bad" }> =
    [];
  for (const s of tpl.slots) {
    const st = statuses[s.id];
    if (st === "empty" && s.required)
      warnings.push({
        id: s.id,
        text: tVehicle("live.missing", { slot: tl(s.label) }),
        tone: "warn",
      });
    else if (st === "lost")
      warnings.push({
        id: s.id,
        text: tVehicle("live.lost", { slot: tl(s.label) }),
        tone: "bad",
      });
    else if (st === "incompatible")
      warnings.push({
        id: s.id,
        text: tVehicle("live.incompatible", { slot: tl(s.label) }),
        tone: "bad",
      });
  }
  const slot = tpl.slots.find((s) => s.id === sel) ?? null;

  return (
    <div className="vh-live">
      <Panel
        title={cfg.name || tl(tpl.name)}
        subtitle={tl(tpl.name)}
        className="vh-live__diagram"
        footer={<Legend />}
      >
        {phase !== "connected" && (
          <p className="vh-note">{tVehicle("live.noBus")}</p>
        )}
        <div className="vh-diagram-box vh-diagram-box--live">
          <VehicleDiagram
            template={tpl}
            statuses={statuses}
            selected={sel}
            live={live}
            yawDeg={gyroSlot ? yaw : undefined}
            onSlotClick={(id) => setSel((cur) => (cur === id ? null : id))}
          />
        </div>
      </Panel>
      <div className="vh-live__side">
        <div className="vh-live__stats">
          <StatTile
            label={tVehicle("live.voltage")}
            value={powerSlot && Number.isFinite(volts) ? volts : null}
            unit="V"
            digits={1}
            caption={powerSlot ? undefined : tVehicle("live.noPower")}
          />
          <StatTile
            label={tVehicle("live.current")}
            value={powerSlot && Number.isFinite(amps) ? amps : null}
            unit="A"
            digits={1}
            caption={powerSlot ? undefined : tVehicle("live.noPower")}
          />
          <StatTile
            label={tVehicle("live.heading")}
            value={gyroSlot && Number.isFinite(yaw) ? yaw : null}
            unit="°"
            digits={0}
            caption={gyroSlot ? undefined : tVehicle("live.noGyro")}
          />
          <div
            className="vh-live__att cy-stat"
            aria-label={tVehicle("live.attitude")}
          >
            <Attitude pitch={pitch} roll={roll} />
            <div className="vh-live__attv vh-mono">
              <span>
                {tVehicle("live.pitch")}{" "}
                {Number.isFinite(pitch) ? `${fmt(pitch)}°` : "—"}
              </span>
              <span>
                {tVehicle("live.roll")}{" "}
                {Number.isFinite(roll) ? `${fmt(roll)}°` : "—"}
              </span>
            </div>
          </div>
        </div>
        <Panel
          title={tVehicle("live.warnings")}
          subtitle={warnings.length > 0 ? String(warnings.length) : undefined}
          className="vh-live__warn"
        >
          {warnings.length === 0 ? (
            <p className="vh-okline">
              <CircleCheck size={15} aria-hidden /> {tVehicle("live.allGood")}
            </p>
          ) : (
            <ul className="vh-issuelist">
              {warnings.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    className={cx(
                      "vh-issue",
                      w.tone === "warn" ? "is-warn" : "is-bad",
                    )}
                    onClick={() => setSel(w.id)}
                  >
                    <TriangleAlert size={13} aria-hidden />
                    <span>{w.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <SlotPanel
          slot={slot}
          binding={slot ? cfg.bindings[slot.id] : undefined}
          status={slot ? statuses[slot.id] : undefined}
        />
      </div>
    </div>
  );
}

/** Default screen once a vehicle is configured: live telemetry on the diagram. */
export function LiveView() {
  const { tl } = useI18n();
  const { cfg, setup, tpl, statuses, dropped } = useSavedVehicle();
  const [confirm, setConfirm] = useState(false);
  // Store the repaired copy once, so the bad bindings do not come back on the next load.
  const droppedKey = dropped.join(",");
  useEffect(() => {
    if (!cfg || droppedKey === "") return;
    setVehicleConfig(cfg);
    toast.warn(tVehicle("live.repaired", { n: droppedKey.split(",").length }), {
      description: tVehicle("live.repairedBody"),
    });
  }, [cfg, droppedKey]);
  if (!cfg) return null;
  const online = Object.values(statuses).filter((s) => s === "online").length;
  const total = tpl?.slots.length ?? 0;
  const bound = tpl
    ? tpl.slots.filter(
        (s) => cfg.bindings[s.id] && cfg.bindings[s.id]?.kind !== "external",
      ).length
    : 0;
  return (
    <Page
      title={tVehicle("nav")}
      subtitle={
        tpl
          ? `${cfg.name || tl(tpl.name)} · ${tVehicle("live.title")}`
          : tVehicle("subtitle")
      }
      icon={CarFront}
      actions={
        <>
          {tpl && (
            <Badge
              tone={online === bound && bound > 0 ? "ok" : "warn"}
              size="md"
            >
              {tVehicle("live.online", { n: online, total })}
            </Badge>
          )}
          <Button
            size="sm"
            icon={Settings2}
            onClick={() => draft.edit(cfg, setup)}
          >
            {tVehicle("live.reconfigure")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={Trash2}
            onClick={() => setConfirm(true)}
          >
            {tVehicle("live.remove")}
          </Button>
        </>
      }
    >
      {tpl ? (
        <Body cfg={cfg} tpl={tpl} statuses={statuses} />
      ) : (
        <Panel>
          <p className="vh-note">
            <strong>{tVehicle("live.unknownTemplate")}</strong> ·{" "}
            {tVehicle("live.unknownTemplateBody", { id: cfg.templateId })}
          </p>
        </Panel>
      )}
      <ConfirmDialog
        open={confirm}
        tone="danger"
        title={tVehicle("live.removeTitle")}
        message={tVehicle("live.removeBody")}
        confirmLabel={tVehicle("live.remove")}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          setVehicleConfig(null);
          vehicleSetup.clear();
          draft.reset();
          toast.info(tVehicle("live.removed"));
        }}
      />
    </Page>
  );
}
