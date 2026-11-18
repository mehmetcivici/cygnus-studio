import { create } from 'zustand';
import type { DeviceHandle } from '@cygnus/protocol';
import type { DeviceStatus } from '../../ui';

/** Why actuation stopped. Every value has a message under `core.drive.reason.*`. */
export type DriveStopReason =
  | 'released'
  | 'estop'
  | 'blur'
  | 'hidden'
  | 'navigation'
  | 'disconnected'
  | 'deviceLost'
  | 'deviceFault'
  | 'preempted';

/** Why `arm()` refused. Messages under `core.drive.block.*`. */
export type ArmBlock = 'estopLatched' | 'notConnected' | 'recovery' | 'deviceOffline' | 'deviceFault' | 'notSupported' | 'ended' | 'otherOwner';

export interface DriveInfo {
  id: number;
  /** Screen/feature that owns the session, e.g. `tuner`. */
  owner: string;
  uid48: string;
  armed: boolean;
  armedAt: number | null;
  /**
   * Increments on every successful `arm()` of this session. Screens key their command state on
   * it so each arming starts from a neutral target, never from the last one.
   */
  armGeneration: number;
}

export interface DriveState {
  /** The one session (armed or not). */
  session: DriveInfo | null;
  /** E-STOP was sent; nothing can be armed until the user clears it. */
  estopLatched: boolean;
  /** Most recent automatic stop, for banners/toasts. */
  lastStop: { reason: DriveStopReason; owner: string; uid48: string; at: number } | null;
}

export const useDrive = create<DriveState>(() => ({ session: null, estopLatched: false, lastStop: null }));

export interface DriveEnv {
  resolve(uid48: string): DeviceHandle | undefined;
  /** The link is up and can carry frames (false once it is lost). */
  isConnected(): boolean;
  /** Current status of a board as the store sees it. */
  statusOf(uid48: string): DeviceStatus | undefined;
  now(): number;
  /** Recovery mode is broadcasting: boards may drop into their bootloader at any moment. */
  recoveryActive?(): boolean;
}

type StopListener = (reason: DriveStopReason) => void;
type ArmListener = (generation: number) => void;

/**
 * Handle given to the screen that drives an actuator. Pattern:
 * `requestDrive` on mount → `arm()` from ArmButton → send commands only while `armed` →
 * `release()` on unmount. Every stop path (manual, focus loss, E-STOP …) runs the screen's
 * `onStop` callbacks first, then `control.stop()` on the board.
 */
export class DriveSession {
  private readonly stopListeners = new Set<StopListener>();
  private readonly armListeners = new Set<ArmListener>();
  private ended = false;

  constructor(
    private readonly ctl: DriveController,
    readonly id: number,
    readonly owner: string,
    readonly uid48: string,
  ) {}

  get active(): boolean {
    return !this.ended && this.ctl.state().session?.id === this.id;
  }

  get armed(): boolean {
    return this.active && this.ctl.state().session?.armed === true;
  }

  /** The board handle (undefined while it is not on the bus). */
  get device(): DeviceHandle | undefined {
    return this.ctl.env.resolve(this.uid48);
  }

  /** Number of times this session was armed (0 = never). See `DriveInfo.armGeneration`. */
  get armGeneration(): number {
    const s = this.ctl.state().session;
    return s?.id === this.id ? s.armGeneration : 0;
  }

  arm(): { ok: true } | { ok: false; reason: ArmBlock } {
    if (!this.active) return { ok: false, reason: 'ended' };
    const block = this.ctl.armBlock(this.uid48);
    if (block) return { ok: false, reason: block };
    this.ctl.setArmed(this.id, true);
    const gen = this.armGeneration;
    for (const cb of this.armListeners) {
      try {
        cb(gen);
      } catch (e) {
        console.error('[drive] arm listener failed', e);
      }
    }
    return { ok: true };
  }

  /** Stops actuation; the session stays owned so it can be re-armed. */
  disarm(reason: DriveStopReason = 'released'): void {
    if (this.armed) this.ctl.stopSession(reason);
  }

  /** Ends the session for good (call on unmount). Stops first if armed. */
  release(): void {
    if (this.ended) return;
    if (this.armed) this.ctl.stopSession('released');
    this.ended = true;
    this.ctl.drop(this.id);
    this.stopListeners.clear();
    this.armListeners.clear();
  }

  /**
   * Runs on every stop while armed (manual, focus loss, E-STOP, link/board loss …), before the
   * board gets its neutral command. Reset the screen's target to neutral here: re-arming must
   * start from zero, never resume the last command.
   */
  onDisarm(cb: StopListener): () => void {
    this.stopListeners.add(cb);
    return () => this.stopListeners.delete(cb);
  }

  /** Same as `onDisarm` (older name). */
  onStop(cb: StopListener): () => void {
    return this.onDisarm(cb);
  }

  /** Runs right after each successful `arm()`, with the new `armGeneration`. */
  onArm(cb: ArmListener): () => void {
    this.armListeners.add(cb);
    return () => this.armListeners.delete(cb);
  }

  /** @internal */
  fireStop(reason: DriveStopReason): void {
    for (const cb of this.stopListeners) {
      try {
        cb(reason);
      } catch (e) {
        console.error('[drive] stop listener failed', e);
      }
    }
  }

  /** @internal */
  markEnded(): void {
    this.ended = true;
  }
}

/**
 * Single-owner actuation sessions. Exactly one session exists at a time; a new request replaces
 * an unarmed one but is refused while another owner is armed (`null`).
 */
export class DriveController {
  private seq = 0;
  private current: DriveSession | null = null;

  constructor(
    readonly env: DriveEnv,
    private readonly store = useDrive,
  ) {}

  state(): DriveState {
    return this.store.getState();
  }

  requestDrive(owner: string, device: DeviceHandle | string): DriveSession | null {
    const uid48 = typeof device === 'string' ? device : device.uid48;
    const cur = this.current;
    if (cur?.active) {
      if (cur.owner === owner && cur.uid48 === uid48) return cur;
      if (cur.armed) return null;
      cur.markEnded();
      this.current = null;
    }
    const s = new DriveSession(this, ++this.seq, owner, uid48);
    this.current = s;
    this.store.setState({ session: { id: s.id, owner, uid48, armed: false, armedAt: null, armGeneration: 0 } });
    return s;
  }

  armBlock(uid48: string): ArmBlock | null {
    if (this.state().estopLatched) return 'estopLatched';
    if (!this.env.isConnected()) return 'notConnected';
    if (this.env.recoveryActive?.()) return 'recovery';
    const h = this.env.resolve(uid48);
    if (!h || !h.online) return 'deviceOffline';
    if (!h.capabilities.control) return 'notSupported';
    const st = this.env.statusOf(uid48);
    if (st === 'fault') return 'deviceFault';
    return null;
  }

  setArmed(id: number, armed: boolean): void {
    const s = this.state().session;
    if (!s || s.id !== id) return;
    this.store.setState({
      session: { ...s, armed, armedAt: armed ? this.env.now() : null, armGeneration: armed ? s.armGeneration + 1 : s.armGeneration },
    });
  }

  /** Stops the armed session (if any) for `reason`. */
  stopSession(reason: DriveStopReason): void {
    const cur = this.current;
    const info = this.state().session;
    if (!cur || !info?.armed) return;
    this.setArmed(info.id, false);
    cur.fireStop(reason);
    // Neutral whenever the frame can still reach the board: also on a user-initiated disconnect
    // (cut while the link is still up). Only a dead link or a vanished board is skipped.
    const dev = cur.device;
    if (dev && dev.online && this.env.isConnected()) {
      try {
        dev.control.stop();
      } catch (e) {
        console.error('[drive] control.stop failed', e);
      }
    }
    if (reason !== 'released') this.store.setState({ lastStop: { reason, owner: cur.owner, uid48: cur.uid48, at: this.env.now() } });
  }

  drop(id: number): void {
    if (this.current?.id !== id) return;
    this.current = null;
    this.store.setState({ session: null });
  }

  /** Environment event: stops actuation when it matters (focus, page, link …). */
  cut(reason: DriveStopReason): void {
    this.stopSession(reason);
  }

  /** Re-checks the session's board after a store update. */
  checkDevice(): void {
    const info = this.state().session;
    if (!info?.armed) return;
    const h = this.env.resolve(info.uid48);
    if (!h || !h.online) this.stopSession('deviceLost');
    else if (this.env.statusOf(info.uid48) === 'fault') this.stopSession('deviceFault');
  }

  /** E-STOP: stop everything and latch until `clearEstopLatch`. The bus broadcast is sent by the caller. */
  estop(): void {
    this.stopSession('estop');
    this.store.setState({ estopLatched: true });
  }

  clearLatch(): void {
    this.store.setState({ estopLatched: false });
  }
}
