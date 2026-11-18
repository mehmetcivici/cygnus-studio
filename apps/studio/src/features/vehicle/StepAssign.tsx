import { useMemo, useState, type DragEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  Eraser,
  GripVertical,
  Lightbulb,
  ListOrdered,
  SkipForward,
  Square,
  StepBack,
  TriangleAlert,
  Undo2,
  Wand2,
} from "lucide-react";
import {
  validateConfig,
  type SlotBinding,
  type VehicleSlot,
  type VehicleTemplate,
} from "@cygnus/vehicles";
import {
  describeError,
  displayName,
  modelText,
  useBus,
  useConnection,
  type DeviceView,
} from "../../core";
import { useI18n } from "../../i18n";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Panel,
  StatusDot,
  cx,
  toast,
} from "../../ui";
import {
  bindingFor,
  candidatesFor,
  seqCurrent,
  seqOrder,
  slotStatuses,
  type Candidate,
  type SlotStatus,
} from "./model";
import { useLites } from "./hooks";
import { draft, useDraft } from "./store";
import { SlotInspector } from "./SlotInspector";
import { DRAG_MIME, ROLE_ICON, VehicleDiagram } from "./VehicleDiagram";
import { tVehicle } from "./messages";

const STATUS_ORDER: readonly SlotStatus[] = [
  "empty",
  "online",
  "lost",
  "external",
  "incompatible",
];

export function Legend() {
  return (
    <ul className="vh-legend" aria-label={tVehicle("assign.legend")}>
      {STATUS_ORDER.map((s) => (
        <li key={s}>
          <span className={cx("vh-legend__dot", `is-${s}`)} />
          {tVehicle(`status.${s}`)}
        </li>
      ))}
    </ul>
  );
}

function SlotChips({
  tpl,
  statuses,
  selected,
  highlight,
  bindings,
  onDrop,
}: {
  tpl: VehicleTemplate;
  statuses: Record<string, SlotStatus>;
  selected: string | null;
  highlight: string | null;
  bindings: Readonly<Record<string, SlotBinding>>;
  onDrop: (slotId: string, uid: string) => void;
}) {
  const { tl } = useI18n();
  const [over, setOver] = useState<string | null>(null);
  return (
    <ul className="vh-chips" aria-label={tVehicle("assign.slotList")}>
      {tpl.slots.map((s) => {
        const Icon = ROLE_ICON[s.role];
        const st = statuses[s.id] ?? "empty";
        return (
          <li key={s.id}>
            <button
              type="button"
              data-slot-chip={s.id}
              className={cx(
                "vh-chip",
                `is-${st}`,
                selected === s.id && "is-selected",
                highlight === s.id && "is-highlight",
                over === s.id && "is-drop",
              )}
              onClick={() => draft.select(s.id)}
              title={`${tl(s.label)} · ${tVehicle(`status.${st}`)}`}
              aria-pressed={selected === s.id}
              onDragOver={(e: DragEvent) => {
                if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
                e.preventDefault();
                setOver(s.id);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                setOver(null);
                const uid = e.dataTransfer.getData(DRAG_MIME);
                if (uid) onDrop(s.id, uid);
              }}
            >
              <span className="vh-chip__dot" />
              <Icon size={13} aria-hidden />
              <span className="vh-chip__label">{tl(s.label)}</span>
              {bindings[s.id] && (
                <CircleCheck size={12} className="vh-chip__ok" aria-hidden />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function BoardRow({
  c,
  view,
  slot,
  tpl,
  onAssign,
}: {
  c: Candidate;
  view: DeviceView | undefined;
  slot: VehicleSlot | null;
  tpl: VehicleTemplate;
  onAssign: (c: Candidate) => void;
}) {
  const { tl, lang } = useI18n();
  const bus = useBus();
  const here = !!slot && c.boundTo.includes(slot.id);
  const others = c.boundTo.filter((id) => id !== slot?.id);
  const label = (id: string): string => {
    const s = tpl.slots.find((x) => x.id === id);
    return s ? tl(s.label) : id;
  };
  const name = view ? displayName(view, lang) : c.device.name;
  const model = view ? tl(modelText(view)) : (c.device.model ?? "");
  const full = c.via === "channel" && c.freeChannels.length === 0;
  return (
    <li
      className={cx(
        "vh-board",
        here && "is-here",
        !c.device.online && "is-offline",
      )}
      draggable
      data-board={c.device.uid48}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, c.device.uid48);
        e.dataTransfer.effectAllowed = "link";
      }}
      title={tVehicle("assign.dragHint")}
    >
      <GripVertical size={14} className="vh-board__grip" aria-hidden />
      <StatusDot status={view?.status ?? "offline"} size={8} />
      <div className="vh-board__main">
        <div className="vh-board__name">
          <span>{name}</span>
          <span className="vh-mono vh-dim">
            {c.device.unassigned ? "#—" : `#${c.device.num}`}
          </span>
          {c.device.unassigned && (
            <Badge size="sm" tone="warn">
              {tVehicle("assign.unnumbered")}
            </Badge>
          )}
          {c.device.conflict && (
            <Badge size="sm" tone="danger">
              {tVehicle("assign.conflict")}
            </Badge>
          )}
        </div>
        <div className="vh-board__sub">
          {name !== model && <span>{model}</span>}
          <span className="vh-mono">{c.device.uid48}</span>
          {c.via === "channel" && (
            <span>
              {tVehicle("channel.chOption", { ch: c.freeChannels[0] ?? "—" })}
            </span>
          )}
        </div>
        {(here || others.length > 0) && (
          <div className="vh-board__used">
            {here && (
              <Badge size="sm" tone="ok">
                {tVehicle("assign.assigned")}
              </Badge>
            )}
            {others.length > 0 && (
              <span className="vh-dim">
                {tVehicle("assign.usedBy", {
                  slot: others.map(label).join(", "),
                })}
              </span>
            )}
          </div>
        )}
      </div>
      <IconButton
        size="sm"
        variant="ghost"
        icon={Lightbulb}
        label={tVehicle("slot.identify")}
        onClick={() => bus?.identifyByUid(c.device.uid48, 5)}
        disabled={!bus}
      />
      {slot && !here && (
        <Button
          size="sm"
          variant={others.length > 0 ? "ghost" : "secondary"}
          onClick={() => onAssign(c)}
          disabled={full}
        >
          {others.length > 0 && c.via !== "channel"
            ? tVehicle("assign.reassign")
            : tVehicle("assign.assignHere")}
        </Button>
      )}
    </li>
  );
}

function Unresolved({ count }: { count: number }) {
  const bus = useBus();
  const [busy, setBusy] = useState(false);
  if (count === 0 || !bus) return null;
  const resolve = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await bus.resolveAll({ persist: false });
      const ok = r.filter((x) => x.ok).length;
      if (ok < r.length)
        toast.warn(tVehicle("assign.resolveFailed"), {
          description: r.find((x) => !x.ok)?.error
            ? describeError(r.find((x) => !x.ok)?.error)
            : undefined,
        });
      else toast.success(tVehicle("assign.resolved", { n: ok }));
    } catch (e) {
      toast.error(tVehicle("assign.resolveFailed"), {
        description: describeError(e),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="vh-banner" role="status">
      <TriangleAlert size={18} aria-hidden />
      <div className="vh-banner__text">
        <strong>{tVehicle("assign.unresolvedTitle", { n: count })}</strong>
        <span>{tVehicle("assign.unresolvedBody")}</span>
      </div>
      <Button
        variant="primary"
        size="sm"
        icon={Wand2}
        loading={busy}
        onClick={() => void resolve()}
      >
        {tVehicle("assign.resolve")}
      </Button>
    </div>
  );
}

function SeqBar({ tpl, filled }: { tpl: VehicleTemplate; filled: number }) {
  const { tl } = useI18n();
  const seq = useDraft((s) => s.seq);
  const bindings = useDraft((s) => s.bindings);
  if (!seq.active) return null;
  const cur = seqCurrent(seq);
  const slot = cur ? tpl.slots.find((s) => s.id === cur) : undefined;
  return (
    <div className="vh-seq" role="status" aria-live="polite">
      <ListOrdered size={18} aria-hidden />
      <div className="vh-banner__text">
        <strong>
          {seq.done
            ? tVehicle("assign.seqDone")
            : tVehicle("assign.seqNow", { slot: slot ? tl(slot.label) : "" })}
        </strong>
        <span>
          {tVehicle("assign.seqProgress", {
            done: filled,
            total: tpl.slots.length,
          })}
          {!seq.done && ` · ${tVehicle("assign.seqHint")}`}
        </span>
      </div>
      <div className="vh-seq__act">
        <Button
          size="sm"
          variant="ghost"
          icon={StepBack}
          onClick={() => draft.seq({ type: "back" })}
        >
          {tVehicle("assign.seqPrev")}
        </Button>
        {!seq.done && (
          <Button
            size="sm"
            variant="ghost"
            icon={SkipForward}
            onClick={() => draft.seq({ type: "skip", bindings })}
          >
            {tVehicle("assign.seqSkip")}
          </Button>
        )}
        <Button
          size="sm"
          icon={Square}
          onClick={() => draft.seq({ type: "stop" })}
        >
          {tVehicle("assign.seqStop")}
        </Button>
      </div>
    </div>
  );
}

/** Step b: boards → slots. Diagram and slot list on the left, the selected slot and the boards on the right. */
export function StepAssign({
  tpl,
  onBack,
  onNext,
}: {
  tpl: VehicleTemplate;
  onBack: () => void;
  onNext: () => void;
}) {
  const { tl } = useI18n();
  const phase = useConnection((s) => s.phase);
  const bindings = useDraft((s) => s.bindings);
  const selected = useDraft((s) => s.selected);
  const seq = useDraft((s) => s.seq);
  const tweaks = useDraft((s) => s.tweaks);
  const history = useDraft((s) => s.history);
  const { lites, byUid } = useLites();
  const statuses = useMemo(
    () => slotStatuses(tpl, bindings, lites),
    [tpl, bindings, lites],
  );
  const issues = useMemo(
    () => validateConfig(tpl, { templateId: tpl.id, name: "", bindings }),
    [tpl, bindings],
  );
  const slot = tpl.slots.find((s) => s.id === selected) ?? null;
  const candidates = useMemo(
    () => candidatesFor(slot, bindings, lites),
    [slot, bindings, lites],
  );
  const unresolved = lites.filter(
    (d) => d.online && (d.unassigned || d.conflict),
  ).length;
  const filled = tpl.slots.filter((s) => bindings[s.id]).length;
  const propellers = tpl.slots.some((s) => s.role === "propeller");
  const connected = phase === "connected";

  const assign = (slotId: string, c: Candidate): void => {
    const b = bindingFor(c);
    if (!b) return;
    draft.bind(slotId, b);
    const s = tpl.slots.find((x) => x.id === slotId);
    toast.success(
      tVehicle("assign.bound", {
        slot: s ? tl(s.label) : slotId,
        board: c.device.name || `#${c.device.num}`,
      }),
      { id: "vh-bound" },
    );
  };
  const onDrop = (slotId: string, uid: string): void => {
    const s = tpl.slots.find((x) => x.id === slotId);
    if (!s) return;
    draft.select(slotId);
    const c = candidatesFor(s, bindings, lites).find(
      (x) => x.device.uid48.toLowerCase() === uid.toLowerCase(),
    );
    if (c) assign(slotId, c);
    else
      toast.warn(tVehicle("assign.noBoards"), {
        description: tVehicle("slot.accepts", {
          models: s.accepts.map((a) => a.model).join(", "),
        }),
      });
  };

  return (
    <div className="vh-assign">
      <div className="vh-assign__top">
        <Unresolved count={unresolved} />
      </div>
      <div className="vh-assign__grid">
        <div className="vh-assign__left">
          <Panel
            title={tVehicle("assign.diagram")}
            subtitle={tVehicle("assign.progress", {
              done: filled,
              total: tpl.slots.length,
            })}
            actions={
              <>
                <Button
                  size="sm"
                  variant={seq.active ? "primary" : "secondary"}
                  icon={ListOrdered}
                  onClick={() =>
                    seq.active
                      ? draft.seq({ type: "stop" })
                      : draft.seq({
                          type: "start",
                          order: seqOrder(tpl),
                          bindings,
                        })
                  }
                >
                  {tVehicle("assign.sequential")}
                </Button>
                <IconButton
                  size="sm"
                  variant="ghost"
                  icon={Undo2}
                  label={tVehicle("assign.undo")}
                  onClick={draft.undo}
                  disabled={history.length === 0}
                />
                <IconButton
                  size="sm"
                  variant="ghost"
                  icon={Eraser}
                  label={tVehicle("assign.clearAll")}
                  onClick={draft.clearAll}
                  disabled={filled === 0}
                />
              </>
            }
            footer={<Legend />}
          >
            <SeqBar tpl={tpl} filled={filled} />
            <div className="vh-diagram-box vh-diagram-box--assign">
              <VehicleDiagram
                template={tpl}
                statuses={statuses}
                selected={selected}
                highlight={seqCurrent(seq)}
                onSlotClick={(id) => draft.select(id)}
                onSlotDrop={onDrop}
              />
            </div>
            <SlotChips
              tpl={tpl}
              statuses={statuses}
              selected={selected}
              highlight={seqCurrent(seq)}
              bindings={bindings}
              onDrop={onDrop}
            />
          </Panel>
          <Panel
            title={tVehicle("assign.issues")}
            subtitle={issues.length > 0 ? String(issues.length) : undefined}
            className="vh-issues"
          >
            {issues.length === 0 ? (
              <p className="vh-okline">
                <CircleCheck size={15} aria-hidden />{" "}
                {tVehicle("assign.noIssues")}
              </p>
            ) : (
              <ul className="vh-issuelist">
                {issues.map((i, k) => (
                  <li key={`${i.code}-${i.slotId ?? k}`}>
                    <button
                      type="button"
                      onClick={() => i.slotId && draft.select(i.slotId)}
                      className={cx(
                        "vh-issue",
                        i.code === "missingRequired" ? "is-warn" : "is-bad",
                      )}
                    >
                      <TriangleAlert size={13} aria-hidden />
                      <span>{tl(i.message)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <div className="vh-assign__right">
          <SlotInspector
            tpl={tpl}
            slot={slot}
            bindings={bindings}
            status={slot ? statuses[slot.id] : undefined}
            lites={lites}
            propellers={propellers}
            invert={slot ? tweaks[slot.id]?.invert : undefined}
          />
          <Panel
            title={
              slot
                ? tVehicle("assign.boardsFor", { slot: tl(slot.label) })
                : tVehicle("assign.boards")
            }
            subtitle={connected ? String(candidates.length) : undefined}
            className="vh-boards"
          >
            {!connected ? (
              <EmptyState
                size="sm"
                title={tVehicle("assign.noBus")}
                description={tVehicle("assign.noBusBody")}
              />
            ) : candidates.length === 0 ? (
              <EmptyState
                size="sm"
                title={tVehicle("assign.noBoards")}
                description={tVehicle("assign.noBoardsBody")}
              />
            ) : (
              <>
                {!slot && (
                  <p className="vh-small vh-dim vh-boards__hint">
                    {tVehicle("assign.boardsAll")}
                  </p>
                )}
                <ul className="vh-boardlist">
                  {candidates.map((c) => (
                    <BoardRow
                      key={c.device.uid48}
                      c={c}
                      view={byUid.get(c.device.uid48.toLowerCase())}
                      slot={slot}
                      tpl={tpl}
                      onAssign={(x) => slot && assign(slot.id, x)}
                    />
                  ))}
                </ul>
              </>
            )}
          </Panel>
        </div>
      </div>
      <div className="vh-stepfoot">
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>
          {tVehicle("back")}
        </Button>
        <span className="vh-dim vh-small">
          {tVehicle("assign.progress", {
            done: filled,
            total: tpl.slots.length,
          })}
        </span>
        <Button variant="primary" iconRight={ArrowRight} onClick={onNext}>
          {tVehicle("assign.toTune")}
        </Button>
      </div>
    </div>
  );
}
