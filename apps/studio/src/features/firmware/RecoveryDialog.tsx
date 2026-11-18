import { useEffect, useState } from 'react';
import { Power, Radio, RotateCcw, Upload } from 'lucide-react';
import type { DeviceHandle } from '@cygnus/protocol';
import { Badge, Button, Modal, Select, Spinner, toast } from '../../ui';
import { useI18n } from '../../i18n';
import { describeError, useBus, useBusyLock, useDevices, useSimulation, displayName } from '../../core';
import { compatibleImages, fmtVersion, imageVersion } from './logic';
import { updateOne, useFwLibrary, useFwUpdate } from './store';
import { rebootOthers, recoveryStep } from './recovery';
import { RunBlock } from './parts';
import { tFirmware } from './messages';

const POLL_MS = 300;

/** Boards waiting in their bootloader, re-read while the dialog is open (the bus has no event for it). */
function useWaiting(): DeviceHandle[] {
  const bus = useBus();
  const [list, setList] = useState<DeviceHandle[]>([]);
  useEffect(() => {
    if (!bus) return setList([]);
    const read = (): void => {
      const next = bus.recovery.devices;
      setList((prev) => (prev.length === next.length && prev.every((d, i) => d === next[i]) ? prev : [...next]));
    };
    read();
    const h = window.setInterval(read, POLL_MS);
    return () => window.clearInterval(h);
  }, [bus]);
  return list;
}

function WaitingRow({ device, flashed, onFlash }: { device: DeviceHandle; flashed: boolean; onFlash: (imageId: string) => void }) {
  const { lang } = useI18n();
  const images = useFwLibrary((s) => s.images);
  const views = useDevices();
  const run = useFwUpdate((s) => s.runs[device.uid48]);
  const running = useFwUpdate((s) => s.running);
  const compatible = compatibleImages(images, { model: device.model, hwRev: device.hwRev });
  const [pick, setPick] = useState<string | null>(compatible[0]?.id ?? null);
  const view = views.find((v) => v.uid48 === device.uid48);
  const name = view ? displayName(view, lang) : device.uid48;
  return (
    <li className="fw-rec__row" data-testid={`fw-rec-${device.uid48}`}>
      <div className="fw-rec__head">
        <strong>{name}</strong>
        <span className="cy-mono fw-rec__uid">{device.uid48}</span>
        {flashed && run?.state === 'done' ? <Badge tone="ok">{tFirmware('recovery.flashed')}</Badge> : <Badge tone="caution">{tFirmware('status.bootloader')}</Badge>}
      </div>
      {compatible.length === 0 ? (
        <p className="fw-dialog__warn">{tFirmware('flash.noCompatible')}</p>
      ) : (
        <div className="fw-rec__act">
          <Select<string>
            size="sm"
            value={pick}
            onChange={setPick}
            ariaLabel={tFirmware('flash.pickImage')}
            options={compatible.map((i) => ({ value: i.id, label: `${fmtVersion(imageVersion(i.header))} · ${i.fileName}` }))}
          />
          <Button size="sm" variant="danger" icon={Upload} disabled={!pick || running || flashed} onClick={() => pick && onFlash(pick)}>
            {tFirmware('recovery.flash')}
          </Button>
        </div>
      )}
      {run && flashed && <RunBlock run={run} />}
    </li>
  );
}

/**
 * "Recover a board that does not start": Studio broadcasts the recovery beacon, the user power-
 * cycles the vehicle, every board stays in its bootloader, the broken one gets an image and the
 * others are restarted (PROTOCOL §9.0).
 */
export function RecoveryDialog({ onClose }: { onClose: () => void }) {
  const { t, lang } = useI18n();
  const bus = useBus();
  const sim = useSimulation();
  const views = useDevices();
  const waiting = useWaiting();
  // Rows stay after a board leaves its bootloader, so its progress and result remain visible.
  const [known, setKnown] = useState<DeviceHandle[]>([]);
  useEffect(() => {
    setKnown((k) => {
      const add = waiting.filter((d) => !k.some((x) => x.uid48 === d.uid48));
      return add.length ? [...k, ...add] : k;
    });
  }, [waiting]);
  const running = useFwUpdate((s) => s.running);
  const [active, setActive] = useState(() => bus?.recovery.active ?? false);
  const [flashed, setFlashed] = useState<Set<string>>(() => new Set());
  const [finishedByUser, setFinished] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // Every waiting board was flashed and the beacon has stopped: nothing left to restart, so the
  // dialog is done (instead of offering "restart 0 boards" next to "Cancel").
  const finished = finishedByUser || (flashed.size > 0 && !active && !running && waiting.every((d) => flashed.has(d.uid48)));
  const step = recoveryStep(active, waiting.length, running, finished);
  useBusyLock(active ? 'firmware.busy.recovery' : null);

  useEffect(() => {
    if (!bus) return;
    setActive(bus.recovery.active);
    return bus.on('recovery', (on) => setActive(on));
  }, [bus]);
  // Closing the dialog always ends the beacon: a forgotten beacon keeps every rebooting board in its bootloader.
  useEffect(() => () => bus?.recovery.stop(), [bus]);

  const start = (): void => {
    bus?.recovery.start();
    setFinished(false);
  };
  const powerCycleSim = (): void => {
    if (!sim) return;
    for (const n of sim.nodes) sim.powerCycle(n.id);
  };
  const flash = (device: DeviceHandle, imageId: string): void => {
    const image = useFwLibrary.getState().images.find((i) => i.id === imageId);
    if (!image) return;
    // The flashed board restarts at the end; with the beacon still on it would stay in its bootloader.
    bus?.recovery.stop();
    setFlashed((s) => new Set(s).add(device.uid48));
    const view = views.find((v) => v.uid48 === device.uid48);
    void updateOne({ device, name: view ? displayName(view, lang) : device.uid48, image });
  };
  const finish = async (): Promise<void> => {
    bus?.recovery.stop();
    setFinishing(true);
    try {
      const r = await rebootOthers(waiting, flashed);
      if (r.failed > 0) toast.error(tFirmware('recovery.rebootFailed', { n: r.failed }));
      else if (r.rebooted > 0) toast.success(tFirmware('recovery.rebooted', { n: r.rebooted }));
      setFinished(true);
    } catch (e) {
      toast.error(tFirmware('recovery.rebootFailed', { n: 1 }), { description: describeError(e) });
    } finally {
      setFinishing(false);
    }
  };

  const stepCls = (s: number): string => {
    const at = step === 'intro' ? 1 : step === 'listening' ? (known.length > 0 ? 3 : 2) : step === 'flashing' ? 3 : 4;
    return s < at ? 'is-done' : s === at ? 'is-current' : '';
  };

  return (
    <Modal
      open
      size="lg"
      dismissible={!running}
      onClose={onClose}
      title={tFirmware('recovery.title')}
      footer={
        <>
          <Button variant="ghost" disabled={running} onClick={onClose}>
            {finished ? t('common.close') : t('common.cancel')}
          </Button>
          {!finished && (
            <Button variant="primary" icon={RotateCcw} disabled={running || finishing || (!active && waiting.length === 0)} loading={finishing} onClick={() => void finish()} data-testid="fw-rec-finish">
              {tFirmware('recovery.finish', { n: Math.max(0, waiting.filter((d) => !flashed.has(d.uid48)).length) })}
            </Button>
          )}
        </>
      }
    >
      <div className="fw-rec" data-step={step}>
        <p className="fw-dialog__lead">{tFirmware('recovery.lead')}</p>
        <ol className="fw-rec__steps">
          <li className={stepCls(1)}>
            <span className="fw-rec__num">1</span>
            <div>
              <strong>{tFirmware('recovery.s1')}</strong>
              <p>{tFirmware('recovery.s1Body')}</p>
              {active ? (
                <Badge tone="accent" icon={Radio}>
                  {tFirmware('recovery.listening')}
                </Badge>
              ) : (
                <Button size="sm" variant="primary" icon={Radio} disabled={!bus || running} onClick={start} data-testid="fw-rec-start">
                  {tFirmware('recovery.start')}
                </Button>
              )}
            </div>
          </li>
          <li className={stepCls(2)}>
            <span className="fw-rec__num">2</span>
            <div>
              <strong>{tFirmware('recovery.s2')}</strong>
              <p>{tFirmware('recovery.s2Body')}</p>
              {sim && active && (
                <Button size="sm" variant="secondary" icon={Power} onClick={powerCycleSim} data-testid="fw-rec-simpower">
                  {tFirmware('recovery.simPower')}
                </Button>
              )}
            </div>
          </li>
          <li className={stepCls(3)}>
            <span className="fw-rec__num">3</span>
            <div>
              <strong>{tFirmware('recovery.s3')}</strong>
              {known.length === 0 ? (
                <p className="fw-rec__wait">
                  {active && <Spinner size={14} />} {tFirmware(active ? 'recovery.waiting' : 'recovery.none')}
                </p>
              ) : (
                <ul className="fw-rec__list">
                  {known.map((d) => (
                    <WaitingRow key={d.uid48} device={d} flashed={flashed.has(d.uid48)} onFlash={(id) => flash(d, id)} />
                  ))}
                </ul>
              )}
            </div>
          </li>
          <li className={stepCls(4)}>
            <span className="fw-rec__num">4</span>
            <div>
              <strong>{tFirmware('recovery.s4')}</strong>
              <p>{finished ? tFirmware('recovery.done') : tFirmware('recovery.s4Body')}</p>
            </div>
          </li>
        </ol>
      </div>
    </Modal>
  );
}
