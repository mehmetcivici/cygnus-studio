import { useState } from "react";
import { Crosshair, CircleCheck } from "lucide-react";
import type { SlotBinding, VehicleTemplate } from "@cygnus/vehicles";
import { describeError, useBus, useSignal } from "../../core";
import { useI18n } from "../../i18n";
import { Badge, Button, Panel, toast } from "../../ui";
import { ALIGNED_DEG, rotToSignedDeg, zeroEncoders } from "./zero";
import { tVehicle } from "./messages";

type Bound = { slotId: string; label: string; uid48: string; model: string };

/** Steer-encoder slots of the template that are bound to a board. */
export function steerEncoders(
  tpl: VehicleTemplate,
  bindings: Readonly<Record<string, SlotBinding>>,
  tl: (t: VehicleTemplate["name"]) => string,
): Bound[] {
  const out: Bound[] = [];
  for (const s of tpl.slots) {
    if (s.role !== "steerEncoder") continue;
    const b = bindings[s.id];
    if (b?.kind === "device") out.push({ slotId: s.id, label: tl(s.label), uid48: b.uid48, model: b.model });
  }
  return out;
}

function Row({
  item,
  busy,
  onZero,
}: {
  item: Bound;
  busy: boolean;
  onZero: () => void;
}) {
  const { fmtNumber } = useI18n();
  const deg = rotToSignedDeg(useSignal(item.uid48, "abs.position"));
  const known = Number.isFinite(deg);
  const aligned = known && Math.abs(deg) <= ALIGNED_DEG;
  return (
    <li className="vh-zero__row" data-zero-slot={item.slotId}>
      <span className="vh-zero__label">{item.label}</span>
      <span className="vh-zero__angle vh-mono" aria-label={tVehicle("zero.angle")}>
        {known ? `${deg >= 0 ? "+" : ""}${fmtNumber(deg, 1)}°` : "—"}
      </span>
      {aligned ? (
        <Badge tone="ok" size="sm" icon={CircleCheck}>
          {tVehicle("zero.aligned")}
        </Badge>
      ) : (
        <Badge tone="neutral" size="sm">
          {tVehicle("zero.notAligned")}
        </Badge>
      )}
      <Button size="sm" variant="ghost" icon={Crosshair} disabled={busy || !known} onClick={onZero}>
        {tVehicle("zero.one")}
      </Button>
    </li>
  );
}

/**
 * Swerve offset step: the user points every wheel straight ahead, then each steer encoder
 * stores its current angle as zero and saves it, so "0°" means "straight" from then on.
 */
export function EncoderZero({
  tpl,
  bindings,
}: {
  tpl: VehicleTemplate;
  bindings: Readonly<Record<string, SlotBinding>>;
}) {
  const { tl } = useI18n();
  const bus = useBus();
  const [busy, setBusy] = useState(false);
  const items = steerEncoders(tpl, bindings, tl);
  if (items.length === 0) return null;

  const run = async (which: Bound[]): Promise<void> => {
    if (!bus) return;
    setBusy(true);
    try {
      const r = await zeroEncoders(which.map((i) => ({ slotId: i.slotId, device: bus.deviceByUid(i.uid48), model: i.model })));
      if (r.failed.length === 0) toast.success(tVehicle("zero.done", { n: r.ok.length }));
      else
        toast.error(tVehicle("zero.failed", { n: r.failed.length }), {
          description: r.failed
            .map((f) => `${which.find((i) => i.slotId === f.slotId)?.label ?? f.slotId}: ${describeError(f.error)}`)
            .join(" · "),
        });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="vh-zero" icon={Crosshair} title={tVehicle("zero.title")} subtitle={tVehicle("zero.subtitle")}>
      <ol className="vh-zero__steps">
        <li>{tVehicle("zero.step1")}</li>
        <li>{tVehicle("zero.step2")}</li>
      </ol>
      <ul className="vh-zero__list">
        {items.map((i) => (
          <Row key={i.slotId} item={i} busy={busy || !bus} onZero={() => void run([i])} />
        ))}
      </ul>
      <div className="vh-test__row">
        <Button variant="primary" icon={Crosshair} loading={busy} disabled={!bus} onClick={() => void run(items)}>
          {tVehicle("zero.all", { n: items.length })}
        </Button>
        <span className="vh-dim vh-small">{tVehicle("zero.note")}</span>
      </div>
    </Panel>
  );
}
