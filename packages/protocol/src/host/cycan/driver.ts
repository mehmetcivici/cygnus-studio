import { Cls, EnumFilter, NUM_MAX, NUM_MIN, SysRsp, Timing } from '../../core/constants';
import type { CanFrame } from '../../core/frame';
import { BROADCAST_ALL } from '../../core/frame';
import { idClass, idDevType, idIndex, idNum, isCyCanId, isToDeviceClass } from '../../core/id';
import { decodeEnumRsp, decodeHeartbeat, encodeAssignId, encodeEnumReq, encodeIdentifyUid } from '../../core/messages';
import { CyError, disconnectedError } from '../errors';
import { RequestTracker } from '../requests';
import type { BusDriver, DeviceEventKind, DeviceHandle, DriverContext } from '../types';
import { parseUid48, uid48ToHex } from '../uid';
import { CyCanDevice, type DeviceHost } from './device';

export interface ResolveStep {
  device: DeviceHandle;
  uid48: string;
  devType: number;
  from: number;
  /** null when every number of that type is taken. */
  to: number | null;
}

export interface ResolveOutcome extends ResolveStep {
  ok: boolean;
  error?: CyError;
}

const addrKey = (devType: number, num: number): number => devType * 64 + num;

/** CyCAN discovery, identity bookkeeping and frame routing to CyCanDevice handles. */
export class CyCanDriver implements BusDriver, DeviceHost {
  readonly id = 'cycan';
  ctx!: DriverContext;
  private readonly byUid = new Map<number, CyCanDevice>();
  /** (devType, num) → boards claiming it; more than one only while in conflict. */
  private readonly byAddr = new Map<number, CyCanDevice[]>();
  private scanTimer: unknown = undefined;
  private windowTimer: unknown = undefined;
  private rescanAfterWindow = false;
  private readonly seenThisRound = new Set<number>();
  private assign!: RequestTracker;
  private running = false;

  attach(ctx: DriverContext): void {
    this.ctx = ctx;
    this.assign = new RequestTracker(
      ctx.scheduler,
      (f) => ctx.send(f),
      () => ctx.countEnumTimeout(),
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const d of this.byUid.values()) d.resume();
    this.scan();
  }

  transportDown(): void {
    this.running = false;
    this.cancelTimers();
    const err = disconnectedError();
    this.assign.failAll(err);
    for (const d of this.byUid.values()) d.transportDown(err);
  }

  stop(): void {
    this.running = false;
    this.cancelTimers();
    const err = new CyError('DISCONNECTED', 'bus stopped');
    this.assign.failAll(err);
    const all = [...this.byUid.values()];
    this.byUid.clear();
    this.byAddr.clear();
    for (const d of all) {
      d.dispose(err);
      this.ctx.emitDevice('deviceRemoved', d);
    }
  }

  haltControl(): void {
    for (const d of this.byUid.values()) d.control.halt();
  }

  devices(): Iterable<DeviceHandle> {
    return this.byUid.values();
  }

  // ---------------------------------------------------------------------------------------
  // Frame routing

  handleFrame(frame: CanFrame): boolean {
    const id = frame.id;
    if (!isCyCanId(id)) return false;
    const cls = idClass(id);
    // Host-to-board classes come from other hosts on the bus; nothing to do.
    if (isToDeviceClass(cls)) return true;
    const devType = idDevType(id);
    if (cls === Cls.ENUM_RSP) {
      this.onEnumRsp(devType, frame);
      return true;
    }
    const num = idNum(id);
    const index = idIndex(id);
    if (cls === Cls.SYS_RSP && index === SysRsp.HEARTBEAT) {
      this.onHeartbeat(devType, num, frame);
      return true;
    }
    const list = this.byAddr.get(addrKey(devType, num));
    const dev = list?.length === 1 ? list[0] : list?.find((d) => d.resolved);
    dev?.handleFrame(frame, cls, index);
    return true;
  }

  private onEnumRsp(devType: number, frame: CanFrame): void {
    const rsp = decodeEnumRsp(frame.data);
    if (!rsp) return;
    this.seenThisRound.add(rsp.uid48);
    let dev = this.byUid.get(rsp.uid48);
    if (!dev) {
      dev = new CyCanDevice(this, rsp, devType, frame.timestamp);
      this.byUid.set(rsp.uid48, dev);
      this.addIndex(dev);
      this.ctx.emitDevice('deviceAdded', dev);
      dev.maybeLoadInfo(frame.timestamp);
    } else {
      dev.applyEnum(rsp, devType, frame.timestamp);
    }
    this.assign.deliver(`a:${rsp.uid48}`, frame.data);
  }

  private onHeartbeat(devType: number, num: number, frame: CanFrame): void {
    const hb = decodeHeartbeat(frame.data);
    if (!hb) return;
    const dev = this.byAddr.get(addrKey(devType, num))?.find((d) => d.uid16 === hb.uid16);
    if (dev) {
      dev.applyHeartbeat(hb, frame.timestamp);
      return;
    }
    // A board we have not enumerated yet (host started late, or it just got a number):
    // scan now, or right after the current discovery window closes.
    if (this.windowTimer === undefined) this.scan();
    else this.rescanAfterWindow = true;
  }

  // ---------------------------------------------------------------------------------------
  // Discovery rounds

  private scan(): void {
    if (!this.running) return;
    if (this.scanTimer !== undefined) this.ctx.scheduler.clearTimeout(this.scanTimer);
    if (this.windowTimer !== undefined) this.ctx.scheduler.clearTimeout(this.windowTimer);
    const s = this.ctx.scheduler;
    this.rescanAfterWindow = false;
    this.seenThisRound.clear();
    this.ctx.send(encodeEnumReq(BROADCAST_ALL, { filter: EnumFilter.ALL }));
    this.windowTimer = s.setTimeout(() => {
      this.windowTimer = undefined;
      for (const d of this.byUid.values()) {
        if (d.online && !this.seenThisRound.has(d.uid48Num)) this.ctx.countEnumTimeout();
      }
      if (this.rescanAfterWindow) this.scan();
    }, Timing.ENUM_WINDOW_MS);
    this.scanTimer = s.setTimeout(() => {
      this.scanTimer = undefined;
      this.scan();
    }, Timing.ENUM_SCAN_MS);
  }

  private cancelTimers(): void {
    const s = this.ctx.scheduler;
    if (this.scanTimer !== undefined) s.clearTimeout(this.scanTimer);
    if (this.windowTimer !== undefined) s.clearTimeout(this.windowTimer);
    this.scanTimer = this.windowTimer = undefined;
  }

  // ---------------------------------------------------------------------------------------
  // DeviceHost

  notify(device: CyCanDevice, kind: DeviceEventKind): void {
    this.ctx.emitDevice(kind, device);
  }

  reindex(device: CyCanDevice, oldDevType: number, oldNum: number): void {
    const key = addrKey(oldDevType, oldNum);
    const list = this.byAddr.get(key);
    if (list) {
      const i = list.indexOf(device);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.byAddr.delete(key);
    }
    this.addIndex(device);
  }

  private addIndex(device: CyCanDevice): void {
    const key = addrKey(device.devType, device.num);
    const list = this.byAddr.get(key);
    if (list) list.push(device);
    else this.byAddr.set(key, [device]);
  }

  // ---------------------------------------------------------------------------------------
  // Lookup and conflict resolution

  deviceByUid(uid: string | number): CyCanDevice | undefined {
    return this.byUid.get(parseUid48(uid));
  }

  /** The (resolved) board answering at an address. */
  deviceAt(devType: number, num: number): CyCanDevice | undefined {
    const list = this.byAddr.get(addrKey(devType, num));
    return list?.find((d) => d.resolved) ?? list?.[0];
  }

  /** Online boards that are unassigned, flagged CONFLICT, or share an address with another online board. */
  unresolved(): CyCanDevice[] {
    const out: CyCanDevice[] = [];
    for (const d of this.byUid.values()) if (d.online && this.isUnresolved(d)) out.push(d);
    return out.sort((a, b) => a.devType - b.devType || a.uid48Num - b.uid48Num);
  }

  private isUnresolved(d: CyCanDevice): boolean {
    if (!d.resolved) return true;
    const list = this.byAddr.get(addrKey(d.devType, d.num));
    // Boards flagged CONFLICT already count as unresolved; two unflagged ones at one address
    // (e.g. both joined while the other was silent) are a conflict the boards have not seen yet.
    return (list?.filter((x) => x.online && x.resolved).length ?? 0) > 1;
  }

  /**
   * First free number of a type. Numbers of known resolved boards stay reserved even while
   * they are lost, so a board that comes back does not collide.
   */
  suggestNumber(devType: number, taken: ReadonlySet<number> = new Set()): number | null {
    const used = new Set(taken);
    for (const d of this.byUid.values()) {
      if (d.devType === devType && !this.isUnresolved(d) && d.resolved) used.add(d.num);
    }
    for (let n = NUM_MIN; n <= NUM_MAX; n++) if (!used.has(n)) return n;
    return null;
  }

  planResolve(): ResolveStep[] {
    const taken = new Map<number, Set<number>>();
    return this.unresolved().map((d) => {
      let t = taken.get(d.devType);
      if (!t) taken.set(d.devType, (t = new Set()));
      const to = this.suggestNumber(d.devType, t);
      if (to !== null) t.add(to);
      return { device: d, uid48: d.uid48, devType: d.devType, from: d.num, to };
    });
  }

  async resolveAll(opts: { persist?: boolean } = {}): Promise<ResolveOutcome[]> {
    const out: ResolveOutcome[] = [];
    for (const step of this.planResolve()) {
      if (step.to === null) {
        out.push({ ...step, ok: false, error: new CyError('INVALID', 'no free number', { reason: 'no_free_number' }) });
        continue;
      }
      try {
        await this.assignId(step.uid48, step.to, { ...opts, force: true });
        out.push({ ...step, ok: true });
      } catch (e) {
        if (e instanceof CyError && e.code === 'DISCONNECTED') throw e;
        out.push({ ...step, ok: false, error: e instanceof CyError ? e : new CyError('INVALID', String(e)) });
      }
    }
    return out;
  }

  /**
   * ASSIGN_ID, confirmed by the board's ENUM_RSP with the new number. Refuses a number held
   * by another resolved board of the same type unless `force`.
   */
  assignId(uid: string | number, num: number, opts: { persist?: boolean; force?: boolean } = {}): Promise<void> {
    try {
      const uid48 = parseUid48(uid);
      if (!Number.isInteger(num) || num < NUM_MIN || num > NUM_MAX) {
        throw new CyError('INVALID', `number ${num} outside ${NUM_MIN}..${NUM_MAX}`, { reason: 'out_of_range' });
      }
      if (!this.running) throw disconnectedError();
      const dev = this.byUid.get(uid48);
      if (dev && !opts.force) {
        const holder = this.deviceAt(dev.devType, num);
        if (holder && holder !== dev && holder.resolved) {
          throw new CyError('INVALID', `#${num} is used by ${holder.uid48}`, { reason: 'number_taken' });
        }
      }
      const persist = opts.persist ?? true;
      return this.assign.request<void>({
        key: `a:${uid48}`,
        what: `ASSIGN_ID ${uid48ToHex(uid48)}`,
        timeoutMs: Timing.ENUM_WINDOW_MS + Timing.REQUEST_TIMEOUT_MS,
        frame: () => encodeAssignId(BROADCAST_ALL, { uid48, newNum: num, persist }),
        accept: (d) => {
          const r = decodeEnumRsp(d);
          return r && r.num === num && !r.conflict ? { kind: 'done', value: undefined } : null;
        },
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  identifyByUid(uid: string | number, seconds: number): void {
    const uid48 = parseUid48(uid);
    this.ctx.send(encodeIdentifyUid(BROADCAST_ALL, { uid48, seconds: Math.max(0, Math.min(255, Math.round(seconds))) }));
  }

  /** Drops a (typically lost) board from the list. */
  forget(uid: string | number): boolean {
    const uid48 = parseUid48(uid);
    const dev = this.byUid.get(uid48);
    if (!dev) return false;
    this.byUid.delete(uid48);
    const key = addrKey(dev.devType, dev.num);
    const list = this.byAddr.get(key)?.filter((d) => d !== dev);
    if (list && list.length > 0) this.byAddr.set(key, list);
    else this.byAddr.delete(key);
    dev.dispose(new CyError('DISCONNECTED', 'device removed'));
    this.ctx.emitDevice('deviceRemoved', dev);
    return true;
  }
}
