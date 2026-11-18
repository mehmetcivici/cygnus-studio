import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, CircleCheck, Play, Shuffle, TriangleAlert } from "lucide-react";
import type { SlotBinding, VehicleSlot } from "@cygnus/vehicles";
import {
  ArmButton,
  describeError,
  useDevice,
  useDriveSession,
} from "../../core";
import { useI18n } from "../../i18n";
import { Button, Checkbox, toast } from "../../ui";
import { TEST_DUTY, runMotorTest, type TestPlan } from "./motorTest";
import { draft } from "./store";
import { tVehicle } from "./messages";

/** Low-power pulse for a servo-board channel, by what the channel drives. */
export function testPulse(slot: VehicleSlot, invert: boolean): number {
  const sign = invert ? -1 : 1;
  switch (slot.role) {
    case "propeller":
      return 1150; // one-directional ESC: just above its minimum
    case "thruster":
      return 1500 + sign * 100;
    default:
      return 1500 + sign * 200;
  }
}

export type TestAnswer = "ok" | "reversed" | "otherWheel";

export interface MotorTestProps {
  slot: VehicleSlot;
  binding: SlotBinding | undefined;
  /** Template has propellers: removing them must be confirmed before a test. */
  propellers: boolean;
  /** Direction tweak from the wizard, so the test shows the direction the vehicle will get. */
  invert?: boolean;
  /** The user answered "did the right wheel turn the right way?". */
  onAnswer?: (answer: TestAnswer) => void;
}

/**
 * Runs the slot for one second at low power through the shared drive session (hold-to-arm,
 * automatic cut-offs), then asks whether the right wheel turned the right way and fixes the
 * assignment or direction from the answer.
 */
export function MotorTest({
  slot,
  binding,
  propellers,
  invert = false,
  onAnswer,
}: MotorTestProps) {
  const { tl } = useI18n();
  const uid = binding && binding.kind !== "external" ? binding.uid48 : null;
  const view = useDevice(uid);
  const { session, armed, busyOwner } = useDriveSession("vehicle", uid);
  const [ack, setAck] = useState(false);
  const [running, setRunning] = useState(false);
  const [asking, setAsking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => session?.onDisarm(() => abortRef.current?.abort()), [session]);
  // A new slot or binding is a new question.
  useEffect(() => setAsking(false), [slot.id, uid]);

  if (!binding || binding.kind === "external")
    return <p className="vh-dim vh-small">{tVehicle("test.notSupported")}</p>;
  const unnumbered = !!view && (view.unassigned || view.conflict);
  const pulse = binding.kind === "channel" ? testPulse(slot, invert) : 0;
  const plan: TestPlan =
    binding.kind === "channel"
      ? { kind: "channel", channel: binding.channel, pulseUs: pulse }
      : { kind: "duty", duty: invert ? -TEST_DUTY : TEST_DUTY };

  const run = async (): Promise<void> => {
    const d = session?.device;
    if (!session || !d || !armed) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setAsking(false);
    try {
      // The runner's own disarm at the end also fires onDisarm (and aborts): only its result counts.
      const out = await runMotorTest(session, d, plan, ac.signal);
      if (out === "done") setAsking(true);
    } catch (e) {
      toast.error(tVehicle("test.failed"), { description: describeError(e) });
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setRunning(false);
    }
  };

  const answer = (a: TestAnswer): void => {
    setAsking(false);
    // The answer is kept with the draft so the tune step shows it, whichever step ran the test.
    if (a !== "otherWheel") draft.setVerified(slot.id, a === "ok");
    if (a === "reversed") {
      draft.setTweak(slot.id, { invert: invert ? undefined : true });
      toast.info(tVehicle("test.reversedDone"), { description: tVehicle("test.retryHint") });
    } else if (a === "otherWheel") {
      draft.unbind(slot.id);
      draft.select(slot.id);
      draft.setStep("assign");
      toast.warn(tVehicle("test.otherWheelDone", { slot: tl(slot.label) }));
    }
    onAnswer?.(a);
  };

  return (
    <div className="vh-test">
      <p className="vh-dim vh-small">{tVehicle("test.body")}</p>
      {binding.kind === "channel" && (
        <p className="vh-small vh-mono">
          {tVehicle("test.channelNote", { ch: binding.channel, us: pulse })}
        </p>
      )}
      {propellers && (
        <div className="vh-warnbox" role="alert">
          <TriangleAlert size={16} aria-hidden />
          <div>
            <strong>{tVehicle("test.propWarn")}</strong>
            <Checkbox
              checked={ack}
              onChange={setAck}
              label={tVehicle("test.propAck")}
            />
          </div>
        </div>
      )}
      {unnumbered && <p className="vh-note">{tVehicle("test.unnumbered")}</p>}
      {busyOwner && (
        <p className="vh-note">{tVehicle("test.busy", { owner: busyOwner })}</p>
      )}
      <div className="vh-test__row">
        <ArmButton
          session={session}
          disabled={unnumbered || (propellers && !ack)}
        />
        <Button
          variant="primary"
          icon={Play}
          disabled={!armed || running || unnumbered || (propellers && !ack)}
          loading={running}
          onClick={() => void run()}
        >
          {running ? tVehicle("test.running") : tVehicle("test.run")}
        </Button>
      </div>
      {asking && (
        <div className="vh-test__ask" role="group" aria-label={tVehicle("test.ask")}>
          <strong>{tVehicle("test.ask")}</strong>
          <span className="vh-dim vh-small">
            {slot.spin
              ? tVehicle("test.askSpin", { dir: tVehicle(`spin.${slot.spin}`) })
              : tVehicle("test.askBody")}
          </span>
          <div className="vh-test__row">
            <Button size="sm" variant="secondary" icon={CircleCheck} onClick={() => answer("ok")}>
              {tVehicle("test.answerOk")}
            </Button>
            <Button size="sm" variant="secondary" icon={ArrowLeftRight} onClick={() => answer("reversed")}>
              {tVehicle("test.answerReversed")}
            </Button>
            <Button size="sm" variant="secondary" icon={Shuffle} onClick={() => answer("otherWheel")}>
              {tVehicle("test.answerOther")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
