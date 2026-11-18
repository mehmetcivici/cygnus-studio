import { useEffect, useRef, useState } from "react";
import { Play, TriangleAlert } from "lucide-react";
import type { SlotBinding, VehicleSlot } from "@cygnus/vehicles";
import {
  ArmButton,
  describeError,
  useDevice,
  useDriveSession,
} from "../../core";
import { Button, Checkbox, toast } from "../../ui";
import { tVehicle } from "./messages";

const TEST_MS = 1000;
const TEST_DUTY = 0.1;

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

export interface MotorTestProps {
  slot: VehicleSlot;
  binding: SlotBinding | undefined;
  /** Template has propellers: removing them must be confirmed before a test. */
  propellers: boolean;
  /** Direction tweak from the wizard, so the test shows the direction the vehicle will get. */
  invert?: boolean;
  onDone?: () => void;
}

/**
 * Runs the slot for one second at low power through the shared drive session (hold-to-arm,
 * automatic cut-offs). A servo-board channel gets a single test pulse on its own channel.
 */
export function MotorTest({
  slot,
  binding,
  propellers,
  invert = false,
  onDone,
}: MotorTestProps) {
  const uid = binding && binding.kind !== "external" ? binding.uid48 : null;
  const view = useDevice(uid);
  const { session, armed, busyOwner } = useDriveSession("vehicle", uid);
  const [ack, setAck] = useState(false);
  const [running, setRunning] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);
  useEffect(
    () =>
      session?.onStop(() => {
        stopRef.current?.();
      }),
    [session],
  );

  if (!binding || binding.kind === "external")
    return <p className="vh-dim vh-small">{tVehicle("test.notSupported")}</p>;
  const unnumbered = !!view && (view.unassigned || view.conflict);
  const pulse = binding.kind === "channel" ? testPulse(slot, invert) : 0;

  const run = async (): Promise<void> => {
    const d = session?.device;
    if (!session || !d || !armed) return;
    setRunning(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      stopRef.current = null;
      d.control.stop();
      setRunning(false);
      session.disarm();
      onDone?.();
    };
    try {
      if (binding.kind === "channel") {
        const ch = binding.channel;
        // A factory-fresh channel does not pulse until enabled; the plan enables it for good later.
        if (d.cachedParam(`ch.${ch}.enable`) !== 1)
          await d.setParam(`ch.${ch}.enable`, 1);
        const first = Math.floor((ch - 1) / 4) * 4 + 1;
        const pulses = [0, 0, 0, 0];
        pulses[ch - first] = pulse;
        d.control.send(
          `channels_${first}_${first + 3}`,
          { pulsesUs: pulses },
          { repeat: true },
        );
      } else {
        d.control.start("duty", invert ? -TEST_DUTY : TEST_DUTY);
      }
      stopRef.current = finish;
      timer = setTimeout(finish, TEST_MS);
    } catch (e) {
      finish();
      toast.error(tVehicle("test.failed"), { description: describeError(e) });
    }
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
    </div>
  );
}
