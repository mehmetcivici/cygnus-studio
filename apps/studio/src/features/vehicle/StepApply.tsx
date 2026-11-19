import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  CircleX,
  Hash,
  Play,
  RotateCcw,
  Save,
  ShieldQuestion,
  SlidersHorizontal,
  Tag,
  TriangleAlert,
} from "lucide-react";
import { CATALOG, PType, paramByKey } from "@cygnus/protocol";
import {
  applyPlan,
  planApply,
  planDevices,
  validateConfig,
  type ApplyResult,
  type ApplyStep,
  type PlanResult,
  type PlanStep,
  type VehicleTemplate,
} from "@cygnus/vehicles";
import {
  describeError,
  displayName,
  setVehicleConfig,
  useBus,
  useConnection,
  type DeviceView,
} from "../../core";
import { useI18n, type Lang } from "../../i18n";
import {
  Badge,
  Button,
  EmptyState,
  Panel,
  ProgressBar,
  cx,
  toast,
} from "../../ui";
import { groupPlan, makeConfig, normUid, slotStatuses } from "./model";
import { VehicleDiagram } from "./VehicleDiagram";
import { EncoderZero } from "./EncoderZero";
import { useLites } from "./hooks";
import { vehicleSetup } from "./project";
import { draft, useDraft } from "./store";
import { BindingText } from "./SlotInspector";
import { tVehicle } from "./messages";

function paramText(
  step: Extract<PlanStep, { kind: "setParam" }>,
  model: string | undefined,
  lang: Lang,
  fmt: (v: number, d?: number) => string,
): { label: string; value: string } {
  const def = model ? CATALOG.find((m) => m.key === model) : undefined;
  const p = def ? paramByKey(def, step.key) : undefined;
  if (!p) return { label: step.key, value: fmt(step.value) };
  let value: string;
  if (p.ptype === PType.BOOL)
    value = step.value ? tVehicle("apply.on") : tVehicle("apply.off");
  else if (p.options)
    value =
      p.options.find((o) => o.value === step.value)?.label[lang] ??
      String(step.value);
  else
    value = `${fmt(step.value, p.ptype === PType.F32 ? Math.max(p.digits, 0) : 0)}${p.unit ? ` ${p.unit}` : ""}`;
  return { label: p.label[lang], value };
}

function stepText(step: ApplyStep, boardName: (uid: string) => string): string {
  switch (step.kind) {
    case "assignNum":
      return tVehicle("apply.stepAssign", {
        board: boardName(step.uid48),
        to: step.to,
      });
    case "assignTemp":
      return tVehicle("apply.stepTemp", {
        board: boardName(step.uid48),
        to: step.to,
      });
    case "rename":
      return tVehicle("apply.stepRename", {
        board: boardName(step.uid48),
        to: step.to,
      });
    case "setParam":
      return tVehicle("apply.stepParam", {
        board: boardName(step.uid48),
        key: step.key,
        value: step.value,
      });
    case "save":
      return tVehicle("apply.stepSave", { board: boardName(step.uid48) });
  }
}

type Run =
  | { phase: "idle" }
  | { phase: "running"; done: number; total: number; last: ApplyStep | null }
  | { phase: "failed"; result: ApplyResult }
  | { phase: "done"; result: ApplyResult };

/** Step d: the grouped change list from planApply, then applyPlan with progress, retry and a summary. */
export function StepApply({
  tpl,
  onBack,
}: {
  tpl: VehicleTemplate;
  onBack: () => void;
}) {
  const { tl, lang, fmtNumber } = useI18n();
  const bus = useBus();
  const phase = useConnection((s) => s.phase);
  const bindings = useDraft((s) => s.bindings);
  const name = useDraft((s) => s.name);
  const templateId = useDraft((s) => s.templateId) ?? tpl.id;
  const tweaks = useDraft((s) => s.tweaks);
  const customSlots = useDraft((s) => s.customSlots);
  const { views, byUid, lites } = useLites();
  const statuses = useMemo(() => slotStatuses(tpl, bindings, lites), [tpl, bindings, lites]);
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const connected = phase === "connected" && !!bus;

  const cfg = useMemo(
    () => makeConfig(templateId, name.trim() || tl(tpl.name), bindings),
    [templateId, name, tpl, tl, bindings],
  );
  const issues = useMemo(() => validateConfig(tpl, cfg), [tpl, cfg]);
  // Recomputed from the live boards (their numbers, names and cached parameters).
  const livePlan = useMemo(
    () =>
      bus
        ? planApply(tpl, cfg, planDevices(views.map((v) => v.handle)), lang)
        : null,
    [bus, tpl, cfg, views, lang],
  );
  // While applying (and after a failure) the list stays as it was when the run started.
  const [snapshot, setSnapshot] = useState<PlanResult | null>(null);
  const plan =
    run.phase === "running" || run.phase === "failed"
      ? (snapshot ?? livePlan)
      : livePlan;
  const groups = useMemo(() => (plan ? groupPlan(plan, tpl.slots.map((x) => x.id)) : []), [plan, tpl]);
  const externals = tpl.slots.filter(
    (s) => bindings[s.id]?.kind === "external",
  );
  const view = (uid: string): DeviceView | undefined => byUid.get(normUid(uid));
  const boardName = (uid: string): string => {
    const v = view(uid);
    return v ? displayName(v, lang) : uid;
  };
  const slotLabel = (id: string): string => {
    const s = tpl.slots.find((x) => x.id === id);
    return s ? tl(s.label) : id;
  };
  const fmt = (v: number, d = 0): string => fmtNumber(v, d);

  const save = (): void => {
    setVehicleConfig(cfg);
    vehicleSetup.set({ customSlots, tweaks });
    toast.success(tVehicle("apply.saved"));
  };

  const start = async (): Promise<void> => {
    if (!bus) return;
    // Re-plan from what the boards hold now: a retry skips what already went through.
    const fresh = planApply(tpl, cfg, planDevices(bus.devices), lang);
    if (fresh.warnings.some((w) => w.code === "modelMismatch")) return;
    setSnapshot(fresh);
    setRun({
      phase: "running",
      done: 0,
      total: fresh.steps.length,
      last: null,
    });
    const result = await applyPlan(bus, fresh, {
      onStep: (r, i, total) =>
        setRun({ phase: "running", done: i + 1, total, last: r.step }),
    });
    if (result.ok) {
      save();
      setRun({ phase: "done", result });
    } else setRun({ phase: "failed", result });
  };

  const blocking = issues.filter((i) => i.code !== "templateMismatch");
  // A bound uid48 that now names a card of another model: applying would write that card.
  const wrongModel = !!plan?.warnings.some((w) => w.code === "modelMismatch");
  const busy = run.phase === "running";

  if (run.phase === "done") {
    const r = run.result.results;
    const count = (k: ApplyStep["kind"]) =>
      r.filter((x) => x.step.kind === k).length;
    return (
      <div className="vh-applydone">
        <div className="vh-applydone__head" role="status">
          <span className="vh-applydone__icon" aria-hidden>
            <CircleCheck size={28} />
          </span>
          <div>
            <h2>{tVehicle("apply.doneTitle")}</h2>
            <p className="vh-dim">
              {tVehicle("apply.doneBody", {
                nums: count("assignNum"),
                names: count("rename"),
                params: count("setParam"),
                saves: count("save"),
              })}
            </p>
          </div>
          <Button variant="primary" iconRight={ArrowRight} onClick={() => draft.close()}>
            {tVehicle("apply.toLive")}
          </Button>
        </div>
        <div className="vh-applydone__body">
          <Panel className="vh-applydone__diagram">
            <div className="vh-diagram-box">
              <VehicleDiagram template={tpl} statuses={statuses} />
            </div>
          </Panel>
          <EncoderZero tpl={tpl} bindings={bindings} />
        </div>
      </div>
    );
  }

  return (
    <div className="vh-apply">
      <div className="vh-apply__grid">
        <Panel
          title={tVehicle("apply.title")}
          subtitle={
            plan
              ? tVehicle("apply.groupCount", { n: plan.steps.length })
              : undefined
          }
          className="vh-apply__list"
        >
          <p className="vh-dim vh-small">{tVehicle("apply.intro")}</p>
          {!connected ? (
            <EmptyState
              size="sm"
              title={tVehicle("apply.noBus")}
              description={tVehicle("apply.noBusBody")}
            />
          ) : groups.length === 0 ? (
            <EmptyState
              size="sm"
              icon={CircleCheck}
              title={tVehicle("apply.nothing")}
              description={tVehicle("apply.nothingBody")}
            />
          ) : (
            <ul className="vh-diff">
              {groups.map((g) => {
                const v = view(g.uid48);
                const model = v?.def?.key;
                return (
                  <li
                    key={g.uid48}
                    className="vh-diff__card"
                    data-diff={g.uid48}
                  >
                    <div className="vh-diff__head">
                      <strong>{g.slotIds.map(slotLabel).join(" · ")}</strong>
                      <span className="vh-dim vh-small">
                        {v ? tl(v.def?.name ?? { tr: "", en: "" }) : ""}{" "}
                        <span className="vh-mono">{g.uid48}</span>
                      </span>
                    </div>
                    <ul className="vh-diff__rows">
                      {g.num.map((s, i) =>
                        s.kind === "assignNum" ? (
                          <li key={`n${i}`}>
                            <Hash size={13} aria-hidden />
                            {s.from >= 1 && s.from <= 62
                              ? tVehicle("apply.numChange", {
                                  from: s.from,
                                  to: s.to,
                                })
                              : tVehicle("apply.numFromNone", { to: s.to })}
                          </li>
                        ) : null,
                      )}
                      {g.name.map((s, i) =>
                        s.kind === "rename" ? (
                          <li key={`r${i}`}>
                            <Tag size={13} aria-hidden />
                            {s.from
                              ? tVehicle("apply.rename", {
                                  from: s.from,
                                  to: s.to,
                                })
                              : tVehicle("apply.renameEmpty", { to: s.to })}
                          </li>
                        ) : null,
                      )}
                      {g.params.map((s, i) => {
                        if (s.kind !== "setParam") return null;
                        const p = paramText(s, model, lang, fmt);
                        return (
                          <li key={`p${i}`}>
                            <SlidersHorizontal size={13} aria-hidden />
                            {tVehicle("apply.param", {
                              label: p.label,
                              value: p.value,
                            })}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
          {externals.length > 0 && (
            <>
              <h3 className="vh-subhead">{tVehicle("apply.externals")}</h3>
              <ul className="vh-extlist">
                {externals.map((s) => (
                  <li key={s.id}>
                    <ShieldQuestion size={13} aria-hidden />
                    <span>{tl(s.label)}</span>
                    <BindingText binding={bindings[s.id]} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
        <div className="vh-apply__side">
          {blocking.length > 0 && (
            <Panel
              title={tVehicle("apply.blocked")}
              icon={CircleX}
              className="vh-apply__blocked"
            >
              <ul className="vh-issuelist">
                {blocking.map((i, k) => (
                  <li key={k} className="vh-issue is-bad">
                    <TriangleAlert size={13} aria-hidden />
                    <span>{tl(i.message)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          {plan && plan.warnings.length > 0 && (
            <Panel title={tVehicle("apply.warnings")} icon={TriangleAlert}>
              <ul className="vh-issuelist">
                {plan.warnings.map((w, k) => (
                  <li key={k} className="vh-issue is-warn">
                    <TriangleAlert size={13} aria-hidden />
                    <span>
                      {w.slotId ? `${slotLabel(w.slotId)}: ` : ""}
                      {tl(w.message)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel title={tVehicle("steps.apply")}>
            {run.phase === "running" && (
              <div className="vh-apply__progress" aria-live="polite">
                <ProgressBar
                  value={run.total > 0 ? run.done / run.total : null}
                  label={tVehicle("apply.running", {
                    done: run.done,
                    total: run.total,
                  })}
                  showPercent
                />
                {run.last && (
                  <p className="vh-small vh-mono vh-dim">
                    {stepText(run.last, boardName)}
                  </p>
                )}
              </div>
            )}
            {run.phase === "failed" && (
              <div className="vh-apply__fail" role="alert">
                {(() => {
                  const bad = run.result.results.find((x) => !x.ok);
                  return bad ? (
                    <>
                      <p className="vh-fail">
                        <CircleX size={15} aria-hidden />{" "}
                        {tVehicle("apply.failedAt", {
                          step: stepText(bad.step, boardName),
                        })}
                      </p>
                      <p className="vh-small">{describeError(bad.error)}</p>
                    </>
                  ) : null;
                })()}
                <ul className="vh-applylog">
                  {run.result.results.map((r, i) => (
                    <li key={i} className={cx(!r.ok && "is-bad")}>
                      {r.ok ? (
                        <CircleCheck size={12} aria-hidden />
                      ) : (
                        <CircleX size={12} aria-hidden />
                      )}
                      {stepText(r.step, boardName)}
                    </li>
                  ))}
                </ul>
                {run.result.skipped.length > 0 && (
                  <p className="vh-small vh-dim">
                    {tVehicle("apply.skipped", {
                      n: run.result.skipped.length,
                    })}
                  </p>
                )}
              </div>
            )}
            <div className="vh-apply__actions">
              {connected && groups.length > 0 ? (
                <Button
                  variant="primary"
                  size="lg"
                  icon={run.phase === "failed" ? RotateCcw : Play}
                  disabled={blocking.length > 0 || wrongModel || busy}
                  loading={busy}
                  onClick={() => void start()}
                  block
                >
                  {run.phase === "failed"
                    ? tVehicle("apply.retry")
                    : tVehicle("apply.run")}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="lg"
                  icon={Save}
                  disabled={blocking.length > 0}
                  block
                  onClick={() => {
                    save();
                    draft.close();
                  }}
                >
                  {tVehicle("apply.saveOnly")}
                </Button>
              )}
              {blocking.length === 0 && plan && plan.steps.length > 0 && (
                <Badge tone="neutral">
                  {tVehicle("apply.groupCount", { n: plan.steps.length })}
                </Badge>
              )}
            </div>
          </Panel>
        </div>
      </div>
      <div className="vh-stepfoot">
        <Button
          variant="ghost"
          icon={ArrowLeft}
          onClick={onBack}
          disabled={busy}
        >
          {tVehicle("back")}
        </Button>
        <span />
        <span />
      </div>
    </div>
  );
}
