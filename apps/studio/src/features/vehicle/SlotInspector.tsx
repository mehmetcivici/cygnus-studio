import { useEffect, useState, type ReactNode } from "react";
import { Cable, Lightbulb, Link2Off, Plug, ShieldQuestion } from "lucide-react";
import type {
  SlotBinding,
  VehicleSlot,
  VehicleTemplate,
} from "@cygnus/vehicles";
import {
  DeviceBadge,
  displayName,
  useBus,
  useDevice,
  useSimulation,
} from "../../core";
import { useI18n } from "../../i18n";
import {
  Badge,
  Button,
  EmptyState,
  NumberField,
  Panel,
  Select,
  TextField,
  toast,
} from "../../ui";
import {
  freeChannels,
  isActuator,
  isEncoder,
  type DeviceLite,
  type SlotStatus,
} from "./model";
import { simAddServoBoard, simHasServoBoard } from "./sim";
import { draft } from "./store";
import { Detect } from "./Detect";
import { MotorTest } from "./MotorTest";
import { modelNames } from "./StepTemplate";
import { ROLE_ICON } from "./VehicleDiagram";
import { tVehicle } from "./messages";

export function StatusBadge({ status }: { status: SlotStatus }) {
  const tone =
    status === "online"
      ? "ok"
      : status === "lost"
        ? "danger"
        : status === "incompatible"
          ? "caution"
          : status === "external"
            ? "accent"
            : "neutral";
  return (
    <Badge
      size="sm"
      tone={tone}
      variant={status === "empty" ? "outline" : "soft"}
    >
      {tVehicle(`status.${status}`)}
    </Badge>
  );
}

/** One-line description of a binding (board, channel or external device). */
export function BindingText({ binding }: { binding: SlotBinding | undefined }) {
  const { lang } = useI18n();
  const view = useDevice(
    binding && binding.kind !== "external" ? binding.uid48 : null,
  );
  if (!binding) return <span className="vh-dim">{tVehicle("slot.empty")}</span>;
  if (binding.kind === "external")
    return (
      <span className="vh-bind">
        <Badge size="sm" tone="accent" icon={ShieldQuestion}>
          {tVehicle("slot.external")}
        </Badge>
        {binding.canId !== undefined && (
          <span className="vh-mono">
            {tVehicle("slot.externalCan", { id: binding.canId })}
          </span>
        )}
        {binding.note && <span className="vh-dim">{binding.note}</span>}
      </span>
    );
  if (binding.kind === "channel")
    return (
      <span className="vh-bind">
        <Cable size={13} aria-hidden />
        <span>
          {tVehicle("slot.channel", {
            board: view ? displayName(view, lang) : binding.uid48,
            ch: binding.channel,
          })}
        </span>
      </span>
    );
  return view ? (
    <DeviceBadge device={view} size="sm" />
  ) : (
    <span className="vh-mono vh-dim">{binding.uid48}</span>
  );
}

function ExternalForm({
  slot,
  binding,
}: {
  slot: VehicleSlot;
  binding: SlotBinding | undefined;
}) {
  const ext = binding?.kind === "external" ? binding : null;
  const [canId, setCanId] = useState<number | null>(
    ext?.canId ?? slot.suggestedNum ?? null,
  );
  const [note, setNote] = useState(ext?.note ?? "");
  useEffect(() => {
    setCanId(ext?.canId ?? slot.suggestedNum ?? null);
    setNote(ext?.note ?? "");
    // Reset the form when another slot is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.id]);
  const mark = (): void => {
    draft.bind(
      slot.id,
      canId === null
        ? { kind: "external", note: note.trim() }
        : { kind: "external", canId, note: note.trim() },
    );
    toast.success(tVehicle("external.marked"));
  };
  return (
    <div className="vh-ext">
      <p className="vh-dim vh-small">{tVehicle("external.body")}</p>
      <div className="vh-ext__row">
        <label className="vh-field">
          <span>{tVehicle("external.canId")}</span>
          <NumberField
            size="sm"
            value={canId}
            integer
            min={0}
            max={62}
            onCommit={setCanId}
            width={90}
            ariaLabel={tVehicle("external.canId")}
          />
        </label>
        <label className="vh-field vh-grow">
          <span>{tVehicle("external.note")}</span>
          <TextField
            size="sm"
            value={note}
            onChange={setNote}
            placeholder={tVehicle("external.notePlaceholder")}
            maxLength={40}
            block
          />
        </label>
      </div>
      <Button size="sm" icon={ShieldQuestion} onClick={mark}>
        {ext ? tVehicle("external.update") : tVehicle("external.mark")}
      </Button>
    </div>
  );
}

function ChannelForm({
  slot,
  tpl,
  bindings,
  lites,
}: {
  slot: VehicleSlot;
  tpl: VehicleTemplate;
  bindings: Readonly<Record<string, SlotBinding>>;
  lites: readonly DeviceLite[];
}) {
  const { tl } = useI18n();
  const sim = useSimulation();
  const boards = lites.filter((d) => d.online && d.model === "servo16");
  const cur = bindings[slot.id];
  const [uid, setUid] = useState<string | null>(
    cur?.kind === "channel" ? cur.uid48 : (boards[0]?.uid48 ?? null),
  );
  const [ch, setCh] = useState<number | null>(
    cur?.kind === "channel" ? cur.channel : null,
  );
  const board = boards.find((b) => b.uid48 === uid) ?? boards[0];
  useEffect(() => {
    if (!uid && boards[0]) setUid(boards[0].uid48);
  }, [uid, boards]);
  const free = board ? freeChannels(bindings, board.uid48, slot.id) : [];
  const chosen = ch ?? free[0] ?? null;
  const slotOf = (c: number): string | undefined => {
    if (!board) return undefined;
    const e = Object.entries(bindings).find(
      ([id, b]) =>
        id !== slot.id &&
        b.kind === "channel" &&
        b.uid48.toLowerCase() === board.uid48.toLowerCase() &&
        b.channel === c,
    );
    const s = e ? tpl.slots.find((x) => x.id === e[0]) : undefined;
    return s ? tl(s.label) : e?.[0];
  };
  return (
    <div className="vh-chan">
      <p className="vh-dim vh-small">{tVehicle("channel.body")}</p>
      {boards.length === 0 ? (
        <div className="vh-chan__none">
          <span className="vh-note">{tVehicle("channel.noBoard")}</span>
          {sim && !simHasServoBoard(sim) && (
            <Button
              size="sm"
              variant="ghost"
              icon={Plug}
              onClick={() => {
                simAddServoBoard(sim);
                toast.info(tVehicle("channel.simAdded"));
              }}
            >
              {tVehicle("channel.simAdd")}
            </Button>
          )}
        </div>
      ) : (
        <div className="vh-ext__row">
          <label className="vh-field vh-grow">
            <span>{tVehicle("channel.board")}</span>
            <Select<string>
              size="sm"
              value={board?.uid48 ?? null}
              onChange={(v) => {
                setUid(v);
                setCh(null);
              }}
              options={boards.map((b) => ({
                value: b.uid48,
                label: `${b.name || "Servo"} · ${b.unassigned ? "#—" : `#${b.num}`} · ${b.uid48}`,
              }))}
            />
          </label>
          <label className="vh-field">
            <span>{tVehicle("channel.channel")}</span>
            <Select<number>
              size="sm"
              value={chosen}
              onChange={setCh}
              width={170}
              ariaLabel={tVehicle("channel.channel")}
              options={Array.from({ length: 16 }, (_, i) => i + 1).map((c) => {
                const used = slotOf(c);
                return {
                  value: c,
                  label: used
                    ? tVehicle("channel.chUsed", { ch: c, slot: used })
                    : tVehicle("channel.chOption", { ch: c }),
                };
              })}
            />
          </label>
        </div>
      )}
      {board && chosen !== null && (
        <Button
          size="sm"
          icon={Cable}
          onClick={() =>
            draft.bind(slot.id, {
              kind: "channel",
              uid48: board.uid48,
              model: "servo16",
              channel: chosen,
            })
          }
        >
          {tVehicle("channel.assign")}
        </Button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="vh-insp__sec">
      <h3 className="vh-subhead">{title}</h3>
      {children}
    </section>
  );
}

export interface SlotInspectorProps {
  tpl: VehicleTemplate;
  slot: VehicleSlot | null;
  bindings: Readonly<Record<string, SlotBinding>>;
  status: SlotStatus | undefined;
  lites: readonly DeviceLite[];
  propellers: boolean;
  invert?: boolean;
}

/** The selected slot: its binding and every way to fill it. */
export function SlotInspector({
  tpl,
  slot,
  bindings,
  status,
  lites,
  propellers,
  invert,
}: SlotInspectorProps) {
  const { tl } = useI18n();
  const bus = useBus();
  const [blinking, setBlinking] = useState(false);
  if (!slot) {
    return (
      <Panel title={tVehicle("slot.binding")} className="vh-insp">
        <EmptyState
          size="sm"
          title={tVehicle("slot.none")}
          description={tVehicle("slot.noneBody")}
        />
      </Panel>
    );
  }
  const Icon = ROLE_ICON[slot.role];
  const b = bindings[slot.id];
  const actuator = isActuator(slot);
  const acceptsChannel = slot.accepts.some((a) => a.via === "channel");
  const sensorDetect = isEncoder(slot) || slot.role === "gyro";
  const boundUid = b && b.kind !== "external" ? b.uid48 : null;

  const identify = (): void => {
    if (!bus || !boundUid) return;
    setBlinking(true);
    bus.identifyByUid(boundUid, 5);
    setTimeout(() => setBlinking(false), 5000);
  };

  return (
    <Panel
      className="vh-insp"
      icon={Icon}
      title={tl(slot.label)}
      subtitle={`${tVehicle(`role.${slot.role}`)}${slot.required ? "" : ` · ${tVehicle("optional")}`}`}
      actions={status && <StatusBadge status={status} />}
    >
      <div className="vh-insp__bind">
        <BindingText binding={b} />
        <div className="vh-insp__bindact">
          {boundUid && (
            <Button
              size="sm"
              variant="ghost"
              icon={Lightbulb}
              onClick={identify}
              disabled={!bus || blinking}
            >
              {blinking
                ? tVehicle("slot.identifying")
                : tVehicle("slot.identify")}
            </Button>
          )}
          {b && (
            <Button
              size="sm"
              variant="ghost"
              icon={Link2Off}
              onClick={() => draft.unbind(slot.id)}
            >
              {tVehicle("slot.unbind")}
            </Button>
          )}
        </div>
      </div>
      {status === "lost" && (
        <p className="vh-note">{tVehicle("slot.boardLost")}</p>
      )}
      <p className="vh-small vh-dim">
        {tVehicle("slot.accepts", { models: modelNames(slot, tl) })}
      </p>

      {sensorDetect && (
        <Section
          title={
            slot.role === "gyro"
              ? tVehicle("detect.gyroTitle")
              : tVehicle("detect.encoderTitle")
          }
        >
          <Detect slot={slot} bindings={bindings} />
        </Section>
      )}
      {actuator && b && b.kind !== "external" && status !== "incompatible" && (
        <Section title={tVehicle("test.title")}>
          <MotorTest
            slot={slot}
            binding={b}
            propellers={propellers}
            invert={invert}
          />
        </Section>
      )}
      {acceptsChannel && (
        <Section title={tVehicle("channel.title")}>
          <ChannelForm
            slot={slot}
            tpl={tpl}
            bindings={bindings}
            lites={lites}
          />
        </Section>
      )}
      {actuator && (
        <Section title={tVehicle("external.title")}>
          <ExternalForm slot={slot} binding={b} />
        </Section>
      )}
    </Panel>
  );
}
