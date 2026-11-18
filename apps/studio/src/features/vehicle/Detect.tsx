import { useEffect, useRef, useState } from "react";
import { Hand, Radar, X } from "lucide-react";
import type { DeviceHandle } from "@cygnus/protocol";
import {
  detectMovedEncoder,
  detectTiltedGyro,
  type SlotBinding,
  type VehicleSlot,
} from "@cygnus/vehicles";
import { describeError, useBus, useSimulation } from "../../core";
import { useI18n } from "../../i18n";
import { Button, ProgressBar, toast } from "../../ui";
import { isEncoder, sameDevice } from "./model";
import { simTilt, simTurn } from "./sim";
import { draft } from "./store";
import { tVehicle } from "./messages";

const TIMEOUT_MS = 15_000;
const MIN_ROT = 0.1;
const MIN_TILT = 15;
const ENCODERS = new Set(["cyncoder"]);

interface Watch {
  device: DeviceHandle;
  base: number[];
}

function readKeys(d: DeviceHandle, keys: readonly string[]): number[] {
  return keys.map((k) => d.getSignal(k));
}

function movement(gyro: boolean, now: number[], base: number[]): number {
  if (gyro) {
    let roll = (now[1] ?? 0) - (base[1] ?? 0);
    while (roll > 180) roll -= 360;
    while (roll < -180) roll += 360;
    return (
      Math.max(Math.abs((now[0] ?? 0) - (base[0] ?? 0)), Math.abs(roll)) /
      MIN_TILT
    );
  }
  return Math.abs((now[0] ?? 0) - (base[0] ?? 0)) / MIN_ROT;
}

/**
 * "Turn it by hand / tilt it and the Studio finds it" for encoder and gyro slots. Watches the
 * numbered boards of that kind that are not bound elsewhere, shows each one's movement live and
 * binds the first that crosses the threshold.
 */
export function Detect({
  slot,
  bindings,
}: {
  slot: VehicleSlot;
  bindings: Readonly<Record<string, SlotBinding>>;
}) {
  const { tl } = useI18n();
  const bus = useBus();
  const sim = useSimulation();
  const gyro = slot.role === "gyro";
  const keys = gyro ? ["pitch", "roll"] : ["position"];
  const [running, setRunning] = useState(false);
  const [left, setLeft] = useState(0);
  const [moves, setMoves] = useState<
    Array<{ uid: string; name: string; v: number }>
  >([]);
  const [result, setResult] = useState<"timeout" | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const untiltRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      untiltRef.current?.();
    },
    [],
  );
  // A different slot is a different search.
  useEffect(() => {
    abortRef.current?.abort();
    setResult(null);
  }, [slot.id]);

  const kindOk = (d: DeviceHandle): boolean =>
    gyro ? d.def?.key === "gyro" : !!d.def && ENCODERS.has(d.def.key);
  const boundElsewhere = (d: DeviceHandle): boolean =>
    Object.entries(bindings).some(
      ([id, b]) => id !== slot.id && sameDevice(b, d.uid48),
    );
  const pool = (bus?.devices ?? []).filter(
    (d) =>
      kindOk(d) &&
      d.online &&
      !d.unassigned &&
      !d.conflict &&
      !boundElsewhere(d),
  );

  const start = (): void => {
    if (!bus || pool.length === 0) return;
    const ctl = new AbortController();
    abortRef.current = ctl;
    setRunning(true);
    setResult(null);
    const t0 = Date.now();
    const watches: Watch[] = pool.map((d) => ({
      device: d,
      base: readKeys(d, keys),
    }));
    const tick = setInterval(() => {
      setLeft(Math.max(0, TIMEOUT_MS - (Date.now() - t0)));
      setMoves(
        watches.map((w) => {
          const now = readKeys(w.device, keys);
          if (!w.base.every(Number.isFinite)) w.base = now;
          return {
            uid: w.device.uid48,
            name:
              w.device.name ||
              `${w.device.def ? tl(w.device.def.name) : ""} #${w.device.num}`,
            v: now.every(Number.isFinite) ? movement(gyro, now, w.base) : 0,
          };
        }),
      );
    }, 100);
    setLeft(TIMEOUT_MS);
    const opts = { timeoutMs: TIMEOUT_MS, devices: pool, signal: ctl.signal };
    const p = gyro
      ? detectTiltedGyro(bus, { ...opts, minTiltDeg: MIN_TILT })
      : detectMovedEncoder(bus, { ...opts, minDeltaRot: MIN_ROT });
    p.then(
      (r) => {
        if (ctl.signal.aborted) return;
        if (!r || !r.device.def) {
          setResult("timeout");
          return;
        }
        draft.bind(slot.id, {
          kind: "device",
          uid48: r.device.uid48,
          model: r.device.def.key,
        });
        void r.device.identify(2).catch(() => undefined);
        toast.success(
          tVehicle("detect.found", {
            board: r.device.name || `${tl(r.device.def.name)} #${r.device.num}`,
          }),
          { id: "vh-bound" },
        );
      },
      (e: unknown) => {
        if (!ctl.signal.aborted) toast.error(describeError(e));
      },
    ).finally(() => {
      clearInterval(tick);
      if (abortRef.current === ctl) abortRef.current = null;
      setRunning(false);
      setMoves([]);
    });
  };

  const cancel = (): void => {
    abortRef.current?.abort();
  };

  const simHelp = (): void => {
    if (!sim) return;
    if (gyro) {
      untiltRef.current?.();
      untiltRef.current = simTilt(sim);
    } else simTurn(sim, slot.id);
  };
  const canSim =
    !!sim &&
    (gyro || (isEncoder(slot) && !!sim.slotPlacements[slot.id]?.shaftId));

  return (
    <div className="vh-detect">
      <p className="vh-dim vh-small">
        {gyro ? tVehicle("detect.gyroBody") : tVehicle("detect.encoderBody")}
      </p>
      {pool.length === 0 && !running ? (
        <p className="vh-note">
          <strong>{tVehicle("detect.noCandidates")}</strong> ·{" "}
          {tVehicle("detect.noCandidatesBody", {
            kind: gyro
              ? tVehicle("detect.gyroKind")
              : tVehicle("detect.encoderKind"),
          })}
        </p>
      ) : (
        <div className="vh-detect__row">
          {running ? (
            <Button icon={X} onClick={cancel}>
              {tVehicle("detect.cancel")}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={Radar}
              onClick={start}
              disabled={!bus}
            >
              {tVehicle("detect.start")}
            </Button>
          )}
          {canSim && (
            <Button
              variant="ghost"
              icon={Hand}
              onClick={simHelp}
              disabled={!running}
            >
              {gyro ? tVehicle("detect.simTilt") : tVehicle("detect.simTurn")}
            </Button>
          )}
        </div>
      )}
      {running && (
        <div className="vh-detect__live" aria-live="polite">
          <ProgressBar
            value={left / TIMEOUT_MS}
            size="sm"
            label={tVehicle("detect.waiting", { s: Math.ceil(left / 1000) })}
          />
          <p className="vh-small vh-dim">
            {tVehicle("detect.candidates", { n: pool.length })}
          </p>
          <ul className="vh-detect__bars">
            {moves.map((m) => (
              <li key={m.uid}>
                <span className="vh-detect__name">{m.name}</span>
                <span className="vh-detect__bar">
                  <span
                    style={{ width: `${Math.min(100, m.v * 100)}%` }}
                    className={m.v >= 1 ? "is-hit" : undefined}
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result === "timeout" && !running && (
        <p className="vh-note">{tVehicle("detect.timeout")}</p>
      )}
    </div>
  );
}
