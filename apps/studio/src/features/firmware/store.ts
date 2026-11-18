import { create } from 'zustand';
import { CyError, getModel, isCyError, type CygnusBus, type CyfwError, type CyfwHeader, type DeviceHandle, type FirmwarePhase, type FirmwareProgress } from '@cygnus/protocol';
import { makeDemoFirmware } from '@cygnus/simulator';
import { toast } from '../../ui';
import { acquireBusyLock, describeError, useConnection } from '../../core';
import { t } from '../../i18n';
import {
  cmpVersion,
  compatibleImages,
  fmtVersion,
  imageVersion,
  parseImage,
  transferRate,
  type FwImage,
  type Ver,
} from './logic';

// ---- image library ----------------------------------------------------------------------

export interface RejectedFile {
  id: number;
  fileName: string;
  error: CyfwError;
  header: CyfwHeader | null;
}

interface LibraryState {
  images: FwImage[];
  rejected: RejectedFile[];
}

export const useFwLibrary = create<LibraryState>(() => ({ images: [], rejected: [] }));

let rejectSeq = 0;

/** Parses and validates every file; broken ones are listed with the reason instead of being added. */
export async function addImageFiles(files: readonly File[]): Promise<{ added: number; rejected: number }> {
  let added = 0;
  let rejected = 0;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = parseImage(file.name, bytes);
    if (r.ok) {
      added++;
      useFwLibrary.setState((s) => ({ images: [...s.images.filter((i) => i.id !== r.image.id), r.image] }));
    } else {
      rejected++;
      useFwLibrary.setState((s) => ({ rejected: [...s.rejected, { id: ++rejectSeq, fileName: r.fileName, error: r.error, header: r.header }] }));
    }
  }
  return { added, rejected };
}

export function removeImage(id: string): void {
  useFwLibrary.setState((s) => ({ images: s.images.filter((i) => i.id !== id) }));
}

export function dismissRejected(id: number | 'all'): void {
  useFwLibrary.setState((s) => ({ rejected: id === 'all' ? [] : s.rejected.filter((r) => r.id !== id) }));
}

/** One image per model, one minor version above the newest installed one (simulator only). */
export function loadDemoImages(devices: readonly DeviceHandle[]): number {
  const newest = new Map<number, Ver>();
  for (const d of devices) {
    if (!d.capabilities.firmware || !d.fw) continue;
    const cur = newest.get(d.model);
    if (!cur || cmpVersion(d.fw, cur) > 0) newest.set(d.model, d.fw);
  }
  let n = 0;
  for (const [model, v] of newest) {
    const next: Ver = { major: v.major, minor: v.minor + 1, patch: 0 };
    const name = `${getModel(model)?.key ?? model}-${fmtVersion(next)}.cyfw`;
    const r = parseImage(name, makeDemoFirmware(model, next));
    if (!r.ok) continue;
    useFwLibrary.setState((s) => ({ images: [...s.images.filter((i) => i.id !== r.image.id), r.image] }));
    n++;
  }
  return n;
}

// ---- update runs -------------------------------------------------------------------------

export type RunState = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'aborted';
export type SkipReason = 'no_image' | 'same_version' | 'offline' | 'legacy';

export interface CardRun {
  uid48: string;
  name: string;
  state: RunState;
  phase: FirmwarePhase | null;
  fraction: number;
  sent: number;
  total: number;
  rewinds: number;
  startedAt: number | null;
  transferAt: number | null;
  rateKBs: number;
  etaS: number | null;
  from: string;
  to: string;
  imageId: string;
  imageName: string;
  durationMs?: number;
  error?: string;
  skip?: SkipReason;
  /** 1-based attempt; a board that stops answering is retried automatically. */
  attempt: number;
  /** Catalog revision the new image expects, and the one this Studio build knows. */
  catalogImage: number;
  catalogStudio: number;
}

export interface LogEntry {
  id: number;
  at: number;
  name: string;
  from: string;
  to: string;
  outcome: 'ok' | 'failed' | 'aborted' | 'skipped' | 'retry';
  detail: string;
}

interface UpdateState {
  running: boolean;
  /** Runs of the latest batch (or single update), keyed by uid48. */
  runs: Record<string, CardRun>;
  order: string[];
  log: LogEntry[];
}

export const useFwUpdate = create<UpdateState>(() => ({ running: false, runs: {}, order: [], log: [] }));

let controller: AbortController | null = null;
let logSeq = 0;
const now = (): number => performance.now();

function patchRun(uid48: string, patch: Partial<CardRun>): void {
  useFwUpdate.setState((s) => {
    const r = s.runs[uid48];
    return r ? { runs: { ...s.runs, [uid48]: { ...r, ...patch } } } : s;
  });
}

function pushLog(e: Omit<LogEntry, 'id' | 'at'>): void {
  useFwUpdate.setState((s) => ({ log: [{ ...e, id: ++logSeq, at: Date.now() }, ...s.log].slice(0, 200) }));
}

function onProgress(uid48: string, p: FirmwareProgress): void {
  const r = useFwUpdate.getState().runs[uid48];
  if (!r) return;
  const patch: Partial<CardRun> = { phase: p.phase, fraction: p.fraction, sent: p.sent, total: p.total, rewinds: p.rewinds };
  if (p.phase === 'transfer') {
    const t0 = r.transferAt ?? now();
    patch.transferAt = t0;
    Object.assign(patch, transferRate(p.sent, p.total, now() - t0));
  }
  patchRun(uid48, patch);
}

function newRun(d: DeviceHandle, name: string, img: FwImage | undefined, state: RunState): CardRun {
  return {
    uid48: d.uid48,
    name,
    state,
    phase: null,
    fraction: 0,
    sent: 0,
    total: img?.bytes.length ?? 0,
    rewinds: 0,
    startedAt: null,
    transferAt: null,
    rateKBs: 0,
    etaS: null,
    from: fmtVersion(d.fw),
    to: img ? fmtVersion(imageVersion(img.header)) : '—',
    imageId: img?.id ?? '',
    imageName: img?.fileName ?? '',
    attempt: 1,
    catalogImage: img?.header.catalogRev ?? 0,
    catalogStudio: img ? (getModel(img.header.model)?.catalogRev ?? 0) : 0,
  };
}

function failure(e: unknown): { aborted: boolean; message: string } {
  return { aborted: isCyError(e, 'ABORTED'), message: describeError(e) };
}

function settle(uid48: string, outcome: { ok: true; durationMs: number; rewinds: number } | { ok: false; error: unknown } | { skipped: SkipReason }): void {
  const run = useFwUpdate.getState().runs[uid48];
  if (!run) return;
  const base = { name: run.name, from: run.from, to: run.to };
  if ('skipped' in outcome) {
    patchRun(uid48, { state: 'skipped', skip: outcome.skipped });
    pushLog({ ...base, outcome: 'skipped', detail: t(`firmware.skip.${outcome.skipped}`) });
  } else if (outcome.ok) {
    patchRun(uid48, { state: 'done', fraction: 1, phase: 'verify', durationMs: outcome.durationMs, rewinds: outcome.rewinds, etaS: 0 });
    pushLog({ ...base, outcome: 'ok', detail: t('firmware.log.okDetail', { s: (outcome.durationMs / 1000).toFixed(1), n: outcome.rewinds }) });
  } else {
    const f = failure(outcome.error);
    patchRun(uid48, { state: f.aborted ? 'aborted' : 'failed', error: f.message });
    pushLog({ ...base, outcome: f.aborted ? 'aborted' : 'failed', detail: f.message });
  }
}

/**
 * While boards are being flashed, leaving the screen, dropping the link or closing the window
 * asks first (core busy lock), and a link loss is explained once.
 */
function installGuards(count: number): () => void {
  const release = acquireBusyLock('firmware.busy.flashing', { n: count });
  const offConn = useConnection.subscribe((s, prev) => {
    if (prev.phase === 'connected' && s.phase !== 'connected') {
      toast.error(t('firmware.guard.linkTitle'), { description: t('firmware.guard.linkBody'), id: 'fw-link', duration: 10000 });
    }
  });
  return () => {
    release();
    offConn();
  };
}

function settleUnfinished(uid48: string, error: unknown): void {
  const st = useFwUpdate.getState().runs[uid48]?.state;
  if (st === 'queued' || st === 'running') settle(uid48, { ok: false, error });
}

function begin(runs: CardRun[]): AbortController {
  controller = new AbortController();
  useFwUpdate.setState((s) => ({
    running: true,
    // A single retry keeps the other cards' earlier results on screen.
    runs: Object.fromEntries([...Object.entries(s.runs).filter(([k]) => !runs.some((r) => r.uid48 === k)), ...runs.map((r) => [r.uid48, r] as const)]),
    order: [...s.order.filter((k) => !runs.some((r) => r.uid48 === k)), ...runs.map((r) => r.uid48)],
  }));
  return controller;
}

function finish(): void {
  controller = null;
  useFwUpdate.setState({ running: false });
}

export function abortUpdate(): void {
  controller?.abort();
}

export function clearRuns(): void {
  if (!useFwUpdate.getState().running) useFwUpdate.setState({ runs: {}, order: [] });
}

export interface Job {
  device: DeviceHandle;
  name: string;
  image: FwImage;
}

/**
 * A lost frame (e.g. the ENTER_BOOTLOADER command, sent once) or a dead window ends an attempt with
 * TIMEOUT. Nothing is lost before the erase and the bootloader restarts a transfer from scratch,
 * so such failures are retried a few times before the user is bothered.
 */
const MAX_ATTEMPTS = 3;

type Outcome = { kind: 'ok'; durationMs: number; rewinds: number } | { kind: 'skipped'; reason: SkipReason } | { kind: 'error'; error: unknown };

/**
 * Runs one board, retrying when it stops answering. A lost final ACK is the host's job now (it
 * repeats END and checks the version in the board's heartbeat), so a failure here is real.
 */
async function runWithRetry(uid48: string, ctl: AbortController, exec: () => Promise<Outcome>): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    patchRun(uid48, { state: 'running', attempt, startedAt: now(), phase: null, fraction: 0, sent: 0, rewinds: 0, transferAt: null, rateKBs: 0, etaS: null, error: undefined });
    const o = await exec();
    if (o.kind === 'ok') return settle(uid48, { ok: true, durationMs: o.durationMs, rewinds: o.rewinds });
    if (o.kind === 'skipped') return settle(uid48, { skipped: o.reason });
    if (isCyError(o.error, 'TIMEOUT') && attempt < MAX_ATTEMPTS && !ctl.signal.aborted) {
      const run = useFwUpdate.getState().runs[uid48];
      if (run) pushLog({ name: run.name, from: run.from, to: run.to, outcome: 'retry', detail: t('firmware.log.retryDetail', { n: attempt + 1, max: MAX_ATTEMPTS }) });
      continue;
    }
    return settle(uid48, { ok: false, error: o.error });
  }
}

/** One board with a chosen image: also the recovery and retry path. Downgrades are allowed here. */
export async function updateOne(job: Job): Promise<void> {
  if (useFwUpdate.getState().running) return;
  const unguard = installGuards(1);
  const { device } = job;
  const ctl = begin([newRun(device, job.name, job.image, 'running')]);
  try {
    await runWithRetry(device.uid48, ctl, async () => {
      try {
        const r = await device.firmware.update(job.image.bytes, { signal: ctl.signal, onProgress: (p) => onProgress(device.uid48, p) });
        return { kind: 'ok', durationMs: r.durationMs, rewinds: r.rewinds };
      } catch (e) {
        return { kind: 'error', error: e };
      }
    });
  } finally {
    unguard();
    finish();
  }
}

/**
 * Boards one after another through `bus.updateAllFirmware` (a one-board call each, so results and
 * retries show as they happen). The bus picks the newest compatible image and skips same versions.
 */
export async function updateMany(bus: CygnusBus, devices: readonly { device: DeviceHandle; name: string }[], images: readonly FwImage[]): Promise<void> {
  if (useFwUpdate.getState().running) return;
  const ordered = [...images].sort((a, b) => cmpVersion(imageVersion(b.header), imageVersion(a.header)));
  const bytes = ordered.map((i) => i.bytes);
  const runs = devices.map(({ device, name }) => newRun(device, name, compatibleImages(ordered, { model: device.model, hwRev: device.hwRev })[0], 'queued'));
  const unguard = installGuards(devices.length);
  const ctl = begin(runs);
  try {
    for (const { device } of devices) {
      const uid = device.uid48;
      // Boards without a firmware protocol never reach the bus API; list them as skipped so the summary is complete.
      if (!device.capabilities.firmware) {
        settle(uid, { skipped: 'legacy' });
        continue;
      }
      if (ctl.signal.aborted) {
        settle(uid, { ok: false, error: new CyError('ABORTED', 'aborted') });
        continue;
      }
      await runWithRetry(uid, ctl, async () => {
        try {
          const [it] = await bus.updateAllFirmware(bytes, { devices: [device], signal: ctl.signal, onProgress: (d, p) => onProgress(d.uid48, p) });
          if (!it) return { kind: 'error', error: new CyError('DISCONNECTED', 'no result') };
          // The link went down mid-queue: a failure to retry, not a board to skip.
          if (it.skipped === 'aborted') return { kind: 'error', error: it.error ?? new CyError('ABORTED', 'aborted') };
          if (it.skipped) return { kind: 'skipped', reason: it.skipped };
          if (it.ok && it.result) return { kind: 'ok', durationMs: it.result.durationMs, rewinds: it.result.rewinds };
          return { kind: 'error', error: it.error };
        } catch (e) {
          return { kind: 'error', error: e };
        }
      });
    }
  } finally {
    unguard();
    finish();
  }
}
