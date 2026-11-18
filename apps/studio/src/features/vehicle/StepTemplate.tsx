import { useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Plus, Trash2 } from "lucide-react";
import { CATALOG } from "@cygnus/protocol";
import {
  getTemplate,
  type SlotRole,
  type VehicleSlot,
  type VehicleTemplate,
} from "@cygnus/vehicles";
import { t as tGlobal, useI18n } from "../../i18n";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  NumberField,
  Panel,
  Select,
  TextField,
} from "../../ui";
import {
  ALL_ROLES,
  addCustomSlot,
  isActuator,
  moveCustomSlot,
  removeCustomSlot,
  slotCounts,
  updateCustomSlot,
} from "./model";
import { draft, useDraft } from "./store";
import { useDraftTemplate } from "./hooks";
import { ROLE_ICON, VehicleDiagram } from "./VehicleDiagram";
import { Gallery } from "./Gallery";
import { tVehicle } from "./messages";

export function modelNames(
  slot: Pick<VehicleSlot, "accepts">,
  tl: (x: { tr: string; en: string }) => string,
): string {
  return slot.accepts
    .map((a) => {
      const d = CATALOG.find((m) => m.key === a.model);
      const n = d ? tl(d.name) : a.model;
      return a.via === "channel" ? `${n} (${tVehicle("setup.channel")})` : n;
    })
    .join(", ");
}

function SlotTable({ tpl }: { tpl: VehicleTemplate }) {
  const { tl } = useI18n();
  return (
    <ul className="vh-slotlist">
      {tpl.slots.map((s) => {
        const Icon = ROLE_ICON[s.role];
        return (
          <li key={s.id} className="vh-slotlist__row" title={modelNames(s, tl)}>
            <Icon size={14} aria-hidden />
            <span className="vh-slotlist__name">{tl(s.label)}</span>
            {s.suggestedNum !== undefined && (
              <span className="vh-mono vh-dim">#{s.suggestedNum}</span>
            )}
            {!s.required && (
              <Badge size="sm" variant="outline">
                {tVehicle("setup.optionalShort")}
              </Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const roleLabel = (role: SlotRole, n: number) => ({
  tr: tGlobal(
    tVehicle.key("custom.slotName"),
    { role: tGlobal(tVehicle.key(`role.${role}`), undefined, "tr"), n },
    "tr",
  ),
  en: tGlobal(
    tVehicle.key("custom.slotName"),
    { role: tGlobal(tVehicle.key(`role.${role}`), undefined, "en"), n },
    "en",
  ),
});

function CustomEditor({
  tpl,
  side,
}: {
  tpl: VehicleTemplate;
  side: ReactNode;
}) {
  const { lang } = useI18n();
  const [role, setRole] = useState<SlotRole>("drive");
  const [sel, setSel] = useState<string | null>(null);
  const slot = tpl.slots.find((s) => s.id === sel) ?? null;
  const add = (): void => {
    const n = tpl.slots.length;
    // Spread new slots on a ring so they do not land on each other.
    const a = (n * 137.5 * Math.PI) / 180;
    const r = n === 0 ? 0 : 0.35 + 0.1 * (n % 5);
    draft.setCustomSlots((slots) => {
      const next = addCustomSlot(slots, role, (k) => roleLabel(role, k), {
        x: r * Math.sin(a),
        y: r * Math.cos(a),
      });
      setSel(next[next.length - 1]?.id ?? null);
      return next;
    });
  };
  return (
    <div className="vh-custom">
      <Panel title={tVehicle("custom.title")} className="vh-custom__diagram">
        <p className="vh-small vh-dim">{tVehicle("custom.hint")}</p>
        <div className="vh-diagram-box">
          <VehicleDiagram
            template={tpl}
            selected={sel}
            onSlotClick={setSel}
            onSlotMove={(id, pos) => {
              setSel(id);
              draft.setCustomSlots((s) => moveCustomSlot(s, id, pos));
            }}
          />
        </div>
      </Panel>
      <div className="vh-custom__side">
        <Panel
          title={tVehicle("setup.slots")}
          subtitle={String(tpl.slots.length)}
        >
          <div className="vh-custom__add">
            <Select<SlotRole>
              size="sm"
              value={role}
              onChange={setRole}
              ariaLabel={tVehicle("custom.role")}
              options={ALL_ROLES.map((r) => ({
                value: r,
                label: tVehicle(`role.${r}`),
              }))}
              width="100%"
            />
            <Button size="sm" variant="primary" icon={Plus} onClick={add}>
              {tVehicle("custom.add")}
            </Button>
          </div>
          {tpl.slots.length === 0 ? (
            <EmptyState
              size="sm"
              title={tVehicle("custom.empty")}
              description={tVehicle("custom.emptyBody")}
            />
          ) : (
            <ul className="vh-custom__list">
              {tpl.slots.map((s) => {
                const Icon = ROLE_ICON[s.role];
                return (
                  <li
                    key={s.id}
                    className={s.id === sel ? "is-selected" : undefined}
                  >
                    <button
                      type="button"
                      className="vh-custom__pick"
                      onClick={() => setSel(s.id)}
                    >
                      <Icon size={14} aria-hidden />
                      <span>{s.label[lang]}</span>
                      <span className="vh-mono vh-dim">
                        {s.pos.x.toFixed(2)}, {s.pos.y.toFixed(2)}
                      </span>
                    </button>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      icon={Trash2}
                      label={tVehicle("custom.remove")}
                      onClick={() =>
                        draft.setCustomSlots((x) => removeCustomSlot(x, s.id))
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {slot && (
            <div className="vh-custom__form">
              <label className="vh-field">
                <span>{tVehicle("custom.label")}</span>
                <TextField
                  size="sm"
                  value={slot.label[lang]}
                  onChange={(v) =>
                    draft.setCustomSlots((x) =>
                      updateCustomSlot(x, slot.id, {
                        label: { ...slot.label, [lang]: v },
                      }),
                    )
                  }
                  maxLength={40}
                />
              </label>
              {isActuator(slot) && slot.role !== "propeller" && (
                <label className="vh-field">
                  <span>{tVehicle("custom.heading")}</span>
                  <NumberField
                    size="sm"
                    value={slot.headingDeg ?? null}
                    unit="°"
                    min={-180}
                    max={180}
                    step={15}
                    commitOnStep
                    onCommit={(v) =>
                      draft.setCustomSlots((x) =>
                        updateCustomSlot(x, slot.id, { headingDeg: v }),
                      )
                    }
                  />
                </label>
              )}
              {slot.role === "propeller" && (
                <label className="vh-field">
                  <span>{tVehicle("custom.spin")}</span>
                  <Select<"cw" | "ccw">
                    size="sm"
                    value={slot.spin ?? "cw"}
                    onChange={(v) =>
                      draft.setCustomSlots((x) =>
                        updateCustomSlot(x, slot.id, { spin: v }),
                      )
                    }
                    options={[
                      { value: "cw", label: tVehicle("spin.cw") },
                      { value: "ccw", label: tVehicle("spin.ccw") },
                    ]}
                  />
                </label>
              )}
              <Checkbox
                checked={slot.required}
                onChange={(v) =>
                  draft.setCustomSlots((x) =>
                    updateCustomSlot(x, slot.id, { required: v }),
                  )
                }
                label={tVehicle("custom.required")}
              />
            </div>
          )}
        </Panel>
        {side}
      </div>
    </div>
  );
}

/** Step a: pick a template (gallery), then name the vehicle; the empty template gets the slot editor. */
export function StepTemplate({ onNext }: { onNext: () => void }) {
  const { tl } = useI18n();
  const templateId = useDraft((s) => s.templateId);
  const name = useDraft((s) => s.name);
  const { tpl } = useDraftTemplate();
  const base = templateId ? getTemplate(templateId) : undefined;

  if (!templateId || !tpl || !base) {
    return (
      <Gallery
        onPick={(id, afterSim) => {
          const t = getTemplate(id);
          draft.chooseTemplate(id, t ? tl(t.name) : id);
          if (afterSim) onNext();
        }}
      />
    );
  }

  const custom = base.category === "custom";
  const c = slotCounts(tpl);
  const canGo = tpl.slots.length > 0;
  const sidePanel = (
    <Panel
      title={tVehicle("setup.title")}
      className="vh-setup__side"
      footer={
        <div className="vh-foot">
          <Button
            icon={ArrowLeft}
            variant="ghost"
            onClick={() => draft.clearTemplate()}
          >
            {tVehicle("setup.change")}
          </Button>
          <Button
            variant="primary"
            iconRight={ArrowRight}
            disabled={!canGo}
            onClick={onNext}
          >
            {tVehicle("setup.toAssign")}
          </Button>
        </div>
      }
    >
      <label className="vh-field">
        <span>{tVehicle("setup.name")}</span>
        <TextField
          value={name}
          onChange={draft.setName}
          placeholder={tVehicle("setup.namePlaceholder")}
          maxLength={60}
          block
        />
      </label>
      <div className="vh-setup__tags">
        <Badge tone="neutral">{tl(base.name)}</Badge>
        {base.competitions.map((comp) => (
          <Badge key={comp} tone="accent" size="sm">
            {comp}
          </Badge>
        ))}
      </div>
      {!custom && (
        <p className="vh-dim vh-small">
          {tVehicle("gallery.counts", {
            a: c.actuators,
            s: c.sensors,
            i: c.infra,
          })}
        </p>
      )}
      {custom && !canGo && (
        <p className="vh-note">{tVehicle("custom.needSlots")}</p>
      )}
      {!custom && (
        <>
          <h3 className="vh-subhead">{tVehicle("setup.slots")}</h3>
          <SlotTable tpl={tpl} />
        </>
      )}
    </Panel>
  );
  if (custom) return <CustomEditor tpl={tpl} side={sidePanel} />;
  return (
    <div className="vh-setup">
      <Panel
        title={tl(tpl.name)}
        subtitle={tl(tpl.description)}
        className="vh-setup__diagram"
      >
        <div className="vh-diagram-box">
          <VehicleDiagram template={tpl} />
        </div>
      </Panel>
      {sidePanel}
    </div>
  );
}
