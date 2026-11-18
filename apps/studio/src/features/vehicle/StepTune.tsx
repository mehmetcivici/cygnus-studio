import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  RotateCcw,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { CATALOG, paramByKey } from "@cygnus/protocol";
import type { VehicleTemplate } from "@cygnus/vehicles";
import { useI18n } from "../../i18n";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  NumberField,
  Panel,
  Toggle,
  cx,
} from "../../ui";
import {
  hasGearRatio,
  invertKey,
  isActuator,
  numberClashes,
  type Tweaks,
} from "./model";
import { draft, useDraft } from "./store";
import { BindingText } from "./SlotInspector";
import { MotorTest } from "./MotorTest";
import { ROLE_ICON, VehicleDiagram } from "./VehicleDiagram";
import { tVehicle } from "./messages";

const gearDef = (model: string) => {
  const d = CATALOG.find((m) => m.key === model);
  return d ? paramByKey(d, "motor.gear_ratio") : undefined;
};

/** Step c: direction, gear ratio and numbers per slot; propeller spin check with a motor test. */
export function StepTune({
  tpl,
  base,
  onBack,
  onNext,
}: {
  tpl: VehicleTemplate;
  base: VehicleTemplate;
  onBack: () => void;
  onNext: () => void;
}) {
  const { tl } = useI18n();
  const bindings = useDraft((s) => s.bindings);
  const tweaks: Tweaks = useDraft((s) => s.tweaks);
  const [sel, setSel] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const rows = tpl.slots.filter((s) => bindings[s.id]);
  const clashes = useMemo(() => numberClashes(tpl, bindings), [tpl, bindings]);
  const slot = rows.find((s) => s.id === sel) ?? null;
  const propellers = tpl.slots.some((s) => s.role === "propeller");

  if (rows.length === 0) {
    return (
      <div className="vh-tune">
        <Panel>
          <EmptyState
            title={tVehicle("tune.noBound")}
            description={tVehicle("tune.noBoundBody")}
          />
        </Panel>
        <div className="vh-stepfoot">
          <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>
            {tVehicle("back")}
          </Button>
          <span />
          <Button variant="primary" iconRight={ArrowRight} onClick={onNext}>
            {tVehicle("tune.toApply")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="vh-tune">
      <div className="vh-tune__grid">
        <Panel
          title={tVehicle("tune.title")}
          subtitle={tVehicle("tune.intro")}
          padding="none"
          className="vh-tune__table"
        >
          <div className="vh-table-scroll">
            <table className="vh-table">
              <thead>
                <tr>
                  <th>{tVehicle("tune.colSlot")}</th>
                  <th>{tVehicle("tune.colBinding")}</th>
                  <th>{tVehicle("tune.colNum")}</th>
                  <th>{tVehicle("tune.colInvert")}</th>
                  <th>{tVehicle("tune.colGear")}</th>
                  {propellers && <th>{tVehicle("tune.colSpin")}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const b = bindings[s.id];
                  const tw = tweaks[s.id] ?? {};
                  const Icon = ROLE_ICON[s.role];
                  const ik = invertKey(b);
                  const gear =
                    b && b.kind === "device" && hasGearRatio(b)
                      ? gearDef(b.model)
                      : undefined;
                  const baseNum = base.slots.find(
                    (x) => x.id === s.id,
                  )?.suggestedNum;
                  return (
                    <tr
                      key={s.id}
                      className={cx(sel === s.id && "is-selected")}
                      onClick={() => setSel(s.id)}
                      data-tune-row={s.id}
                    >
                      <td>
                        <span className="vh-cell-slot">
                          <Icon size={14} aria-hidden />
                          {tl(s.label)}
                        </span>
                      </td>
                      <td className="vh-cell-bind">
                        <BindingText binding={b} />
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {b?.kind === "device" ? (
                          <span className="vh-cell-num">
                            <NumberField
                              size="sm"
                              integer
                              min={1}
                              max={62}
                              width={84}
                              value={s.suggestedNum ?? null}
                              placeholder={tVehicle("tune.keep")}
                              dirty={tw.num !== undefined}
                              error={
                                clashes.has(s.id)
                                  ? tVehicle("tune.clash")
                                  : undefined
                              }
                              onCommit={(v) =>
                                draft.setTweak(s.id, {
                                  num: v === baseNum ? undefined : v,
                                })
                              }
                              ariaLabel={`${tl(s.label)} · ${tVehicle("tune.colNum")}`}
                            />
                            {tw.num !== undefined && (
                              <IconButton
                                size="sm"
                                variant="ghost"
                                icon={RotateCcw}
                                label={tVehicle("tune.reset")}
                                onClick={() =>
                                  draft.setTweak(s.id, { num: undefined })
                                }
                              />
                            )}
                          </span>
                        ) : b?.kind === "channel" ? (
                          <span className="vh-dim vh-mono">
                            {tVehicle("channel.chOption", { ch: b.channel })}
                          </span>
                        ) : (
                          <span className="vh-dim">—</span>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {ik ? (
                          <Toggle
                            size="sm"
                            checked={tw.invert ?? false}
                            onChange={(v) =>
                              draft.setTweak(s.id, {
                                invert: v ? true : undefined,
                              })
                            }
                            ariaLabel={`${tl(s.label)} · ${tVehicle("tune.colInvert")}`}
                          />
                        ) : (
                          <span className="vh-dim">—</span>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {gear ? (
                          <NumberField
                            size="sm"
                            width={120}
                            value={tw.gearRatio ?? null}
                            placeholder={tVehicle("tune.keep")}
                            min={gear.min}
                            max={gear.max}
                            step={0.01}
                            dirty={tw.gearRatio !== undefined}
                            onCommit={(v) =>
                              draft.setTweak(s.id, { gearRatio: v })
                            }
                            ariaLabel={`${tl(s.label)} · ${tVehicle("tune.colGear")}`}
                          />
                        ) : (
                          <span className="vh-dim">—</span>
                        )}
                      </td>
                      {propellers && (
                        <td>
                          {s.spin ? (
                            <span className="vh-cell-spin">
                              {s.spin === "cw" ? (
                                <RotateCw size={14} aria-hidden />
                              ) : (
                                <RotateCcw size={14} aria-hidden />
                              )}
                              {s.spin.toUpperCase()}
                              {checked[s.id] && (
                                <CircleCheck
                                  size={14}
                                  className="vh-ok"
                                  aria-label={tVehicle("tune.spinChecked")}
                                />
                              )}
                            </span>
                          ) : (
                            <span className="vh-dim">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel
          title={slot ? tl(slot.label) : tVehicle("tune.side")}
          className="vh-tune__side"
        >
          {!slot ? (
            <>
              <div className="vh-diagram-box vh-diagram-box--small">
                <VehicleDiagram
                  template={tpl}
                  compact
                  onSlotClick={(id) =>
                    rows.some((r) => r.id === id) && setSel(id)
                  }
                />
              </div>
              <p className="vh-dim vh-small">{tVehicle("tune.sideNone")}</p>
            </>
          ) : (
            <>
              <div className="vh-diagram-box vh-diagram-box--small">
                <VehicleDiagram
                  template={tpl}
                  compact
                  selected={slot.id}
                  onSlotClick={(id) =>
                    rows.some((r) => r.id === id) && setSel(id)
                  }
                />
              </div>
              {slot.spin && (
                <div className="vh-spincheck">
                  <h3 className="vh-subhead">{tVehicle("tune.spinCheck")}</h3>
                  <p>
                    <Badge tone="accent">
                      {tVehicle("tune.spinExpect", {
                        dir: tVehicle(`spin.${slot.spin}`),
                      })}
                    </Badge>
                  </p>
                  <p className="vh-dim vh-small">{tVehicle("tune.spinBody")}</p>
                </div>
              )}
              {isActuator(slot) && (
                <MotorTest
                  slot={slot}
                  binding={bindings[slot.id]}
                  propellers={propellers}
                  invert={tweaks[slot.id]?.invert}
                />
              )}
              {slot.spin && (
                <div className="vh-test__row">
                  <Button
                    size="sm"
                    icon={CircleCheck}
                    onClick={() =>
                      setChecked((c) => ({ ...c, [slot.id]: true }))
                    }
                  >
                    {tVehicle("tune.spinOk")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={TriangleAlert}
                    onClick={() => {
                      draft.setTweak(slot.id, {
                        invert: !(tweaks[slot.id]?.invert ?? false)
                          ? true
                          : undefined,
                      });
                      setChecked((c) => ({ ...c, [slot.id]: false }));
                    }}
                  >
                    {tVehicle("tune.spinWrong")}
                  </Button>
                </div>
              )}
            </>
          )}
        </Panel>
      </div>
      <div className="vh-stepfoot">
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>
          {tVehicle("back")}
        </Button>
        <span />
        <Button variant="primary" iconRight={ArrowRight} onClick={onNext}>
          {tVehicle("tune.toApply")}
        </Button>
      </div>
    </div>
  );
}
