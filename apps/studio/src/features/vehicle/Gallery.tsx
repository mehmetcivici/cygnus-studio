import { useMemo, useState } from "react";
import { ArrowRight, FlaskConical } from "lucide-react";
import {
  templateCategories,
  templates,
  type VehicleTemplate,
} from "@cygnus/vehicles";
import { useI18n } from "../../i18n";
import { Badge, Button, EmptyState, Tabs, toast } from "../../ui";
import { slotCounts } from "./model";
import { hasSimScenario, startSimVehicle } from "./sim";
import { VehicleDiagram } from "./VehicleDiagram";
import { tVehicle } from "./messages";

type Cat = VehicleTemplate["category"] | "all";

export function TemplateCard({
  tpl,
  onPick,
  onTrySim,
  busy,
}: {
  tpl: VehicleTemplate;
  onPick: () => void;
  onTrySim?: () => void;
  busy?: boolean;
}) {
  const { tl } = useI18n();
  const c = slotCounts(tpl);
  return (
    <article className="vh-tcard" data-template={tpl.id}>
      <button
        type="button"
        className="vh-tcard__preview"
        onClick={onPick}
        aria-label={tl(tpl.name)}
      >
        <VehicleDiagram template={tpl} compact />
      </button>
      <div className="vh-tcard__body">
        <div className="vh-tcard__head">
          <h3 className="vh-tcard__name">{tl(tpl.name)}</h3>
          <span className="vh-tcard__count">
            {tpl.slots.length > 0 ? tpl.slots.length : ""}
          </span>
        </div>
        <p className="vh-tcard__desc">{tl(tpl.description)}</p>
        <div className="vh-tcard__tags">
          {tpl.competitions.map((comp) => (
            <Badge key={comp} size="sm" tone="accent">
              {comp}
            </Badge>
          ))}
        </div>
        <p className="vh-tcard__meta">
          {tpl.slots.length > 0
            ? tVehicle("gallery.counts", {
                a: c.actuators,
                s: c.sensors,
                i: c.infra,
              })
            : tVehicle("gallery.noSlots")}
        </p>
      </div>
      <div className="vh-tcard__foot">
        <Button
          size="sm"
          variant="primary"
          iconRight={ArrowRight}
          onClick={onPick}
        >
          {tVehicle("gallery.pick")}
        </Button>
        {onTrySim && (
          <Button
            size="sm"
            variant="ghost"
            icon={FlaskConical}
            onClick={onTrySim}
            loading={busy}
            title={tVehicle("gallery.trySimHint")}
          >
            {tVehicle("gallery.trySim")}
          </Button>
        )}
      </div>
    </article>
  );
}

/** Template gallery: category filter, live diagram previews, competition tags. */
export function Gallery({
  onPick,
}: {
  onPick: (id: string, afterSim?: boolean) => void;
}) {
  const { tl } = useI18n();
  const [cat, setCat] = useState<Cat>("all");
  const [starting, setStarting] = useState<string | null>(null);
  const shown = useMemo(
    () => templates.filter((x) => cat === "all" || x.category === cat),
    [cat],
  );

  const trySim = async (tpl: VehicleTemplate): Promise<void> => {
    setStarting(tpl.id);
    try {
      const ok = await startSimVehicle(tpl.id);
      if (ok) {
        toast.success(tVehicle("gallery.simStarted", { name: tl(tpl.name) }));
        onPick(tpl.id, true);
      } else toast.error(tVehicle("gallery.simFailed"));
    } finally {
      setStarting(null);
    }
  };

  return (
    <div className="vh-gallery">
      <div className="vh-gallery__bar">
        <Tabs<Cat>
          variant="pill"
          ariaLabel={tVehicle("gallery.categories")}
          value={cat}
          onChange={setCat}
          items={[
            {
              id: "all",
              label: tVehicle("gallery.all"),
              badge: templates.length,
            },
            ...templateCategories.map((c) => ({
              id: c.id,
              label: tl(c.name),
              badge: templates.filter((x) => x.category === c.id).length,
            })),
          ]}
        />
        <p className="vh-gallery__intro">{tVehicle("gallery.intro")}</p>
      </div>
      {shown.length === 0 ? (
        <EmptyState size="sm" title={tVehicle("gallery.empty")} />
      ) : (
        <div className="vh-gallery__grid">
          {shown.map((tpl) => (
            <TemplateCard
              key={tpl.id}
              tpl={tpl}
              onPick={() => onPick(tpl.id)}
              onTrySim={
                hasSimScenario(tpl.id) ? () => void trySim(tpl) : undefined
              }
              busy={starting === tpl.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
