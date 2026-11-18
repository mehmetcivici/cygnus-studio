import { NUM_MAX, NUM_MIN, type DeviceHandle } from '@cygnus/protocol';
import type { PlanDevice, PlanResult, PlanStep } from './plan';

/** What `applyPlan` needs from the host bus (a `CygnusBus` fits). */
export interface ApplyBus {
  readonly devices: readonly DeviceHandle[];
  deviceByUid(uid48: string): DeviceHandle | undefined;
  assignId(uid48: string, num: number, opts?: { persist?: boolean; force?: boolean }): Promise<void>;
}

/** A plan step as executed: plan steps, a temporary number to break a swap, and the final saves. */
export type ApplyStep =
  | PlanStep
  | { kind: 'assignTemp'; uid48: string; slotId: string; devType: number; from: number; to: number }
  | { kind: 'save'; uid48: string };

export interface ApplyStepResult {
  step: ApplyStep;
  ok: boolean;
  error?: Error;
}

export interface ApplyResult {
  ok: boolean;
  /** One entry per executed step; execution stops at the first failure. */
  results: ApplyStepResult[];
  /** Steps that were not run because an earlier one failed. */
  skipped: ApplyStep[];
}

export interface ApplyOptions {
  /** Called after every step with its outcome; `index` counts from 0 up to `total`. */
  onStep?: (result: ApplyStepResult, index: number, total: number) => void;
  /** Write numbers to flash and save names/parameters on the boards (default true). */
  persist?: boolean;
}

/** Plan input for `planApply` from the boards the host currently knows (online, numbered or not). */
export function planDevices(devices: readonly DeviceHandle[]): PlanDevice[] {
  const out: PlanDevice[] = [];
  for (const d of devices) {
    if (!d.online || !d.def) continue;
    out.push({ uid48: d.uid48, model: d.def.key, devType: d.devType, num: d.num, name: d.name, params: Object.fromEntries(d.params) });
  }
  return out;
}

const norm = (uid: string): string => uid.toLowerCase();

/**
 * Orders number assignments so no board ever takes a number another board still holds
 * (that would put both into CONFLICT, PROTOCOL §3.4): a board whose target is occupied by
 * a board that moves later waits for it; a cycle (two boards swapping) goes through a free
 * temporary number.
 */
function orderAssignments(steps: Array<Extract<PlanStep, { kind: 'assignNum' }>>, bus: ApplyBus): ApplyStep[] {
  const out: ApplyStep[] = [];
  const holder = new Map<string, string>(); // devType:num → uid
  for (const d of bus.devices) if (d.num >= NUM_MIN && d.num <= NUM_MAX) holder.set(`${d.devType}:${d.num}`, norm(d.uid48));
  const targets = new Set(steps.map((s) => `${s.devType}:${s.to}`));
  const pending = [...steps];
  const current = new Map(steps.map((s) => [norm(s.uid48), s.from]));
  while (pending.length > 0) {
    const i = pending.findIndex((s) => {
      const h = holder.get(`${s.devType}:${s.to}`);
      return h === undefined || h === norm(s.uid48);
    });
    if (i >= 0) {
      const s = pending.splice(i, 1)[0]!;
      const u = norm(s.uid48);
      holder.delete(`${s.devType}:${current.get(u)}`);
      holder.set(`${s.devType}:${s.to}`, u);
      current.set(u, s.to);
      out.push(s);
      continue;
    }
    const s = pending[0]!;
    const blocker = holder.get(`${s.devType}:${s.to}`);
    if (!pending.some((p) => norm(p.uid48) === blocker)) {
      // Held by a board outside the plan (planApply avoids this): assign as planned.
      pending.shift();
      out.push(s);
      continue;
    }
    // Every remaining target is held by a board that still has to move (a cycle): park one aside.
    let temp = NUM_MAX;
    while (temp >= NUM_MIN && (holder.has(`${s.devType}:${temp}`) || targets.has(`${s.devType}:${temp}`))) temp--;
    if (temp < NUM_MIN) {
      // No room to park: assign as planned and let the conflict resolution of the host sort it out.
      pending.shift();
      out.push(s);
      continue;
    }
    const u = norm(s.uid48);
    const from = current.get(u) ?? s.from;
    out.push({ kind: 'assignTemp', uid48: s.uid48, slotId: s.slotId, devType: s.devType, from, to: temp });
    holder.delete(`${s.devType}:${from}`);
    holder.set(`${s.devType}:${temp}`, u);
    current.set(u, temp);
    pending[0] = { ...s, from: temp };
  }
  return out;
}

/**
 * Executes a `planApply` result on the bus with the host API: number assignments first (in a
 * collision-free order), then names and parameters, then `save` on every board that changed.
 * Stops at the first failure and reports what ran and what was skipped.
 */
export async function applyPlan(bus: ApplyBus, plan: PlanResult | readonly PlanStep[], opts: ApplyOptions = {}): Promise<ApplyResult> {
  const persist = opts.persist ?? true;
  const steps: readonly PlanStep[] = 'steps' in plan ? plan.steps : plan;
  const assigns = steps.filter((s): s is Extract<PlanStep, { kind: 'assignNum' }> => s.kind === 'assignNum');
  const rest = steps.filter((s) => s.kind !== 'assignNum');
  const all: ApplyStep[] = [...orderAssignments(assigns, bus), ...rest];
  if (persist) {
    const touched: string[] = [];
    for (const s of rest) if (!touched.includes(norm(s.uid48))) touched.push(norm(s.uid48));
    for (const uid of touched) all.push({ kind: 'save', uid48: uid });
  }

  const results: ApplyStepResult[] = [];
  for (let i = 0; i < all.length; i++) {
    const step = all[i]!;
    let r: ApplyStepResult;
    try {
      await run(bus, step, persist);
      r = { step, ok: true };
    } catch (e) {
      r = { step, ok: false, error: e instanceof Error ? e : new Error(String(e)) };
    }
    results.push(r);
    opts.onStep?.(r, i, all.length);
    if (!r.ok) return { ok: false, results, skipped: all.slice(i + 1) };
  }
  return { ok: true, results, skipped: [] };
}

async function run(bus: ApplyBus, step: ApplyStep, persist: boolean): Promise<void> {
  if (step.kind === 'assignNum' || step.kind === 'assignTemp') {
    // The order above guarantees the number is free when it is assigned; `force` only skips
    // the host's check against boards it still lists at that number.
    await bus.assignId(step.uid48, step.to, { persist, force: true });
    return;
  }
  const d = bus.deviceByUid(step.uid48);
  if (!d) throw new Error(`board ${step.uid48} is not on the bus`);
  switch (step.kind) {
    case 'rename':
      await d.rename(step.to);
      return;
    case 'setParam':
      await d.setParam(step.key, step.value);
      return;
    case 'save':
      await d.save();
      return;
  }
}
