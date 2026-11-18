import { describe, expect, it } from 'vitest';
import { Model, NUM_UNASSIGNED } from '../../src/core/constants';
import { settle, run } from '../helpers/fake-bus';
import { caught, rig } from '../helpers/setup';

describe('conflicts and number assignment', () => {
  it('lists conflicting and unassigned boards and resolves them with the first free numbers', async () => {
    const r = await rig();
    const keep = r.node({ model: Model.ESC_20A, seed: 10, num: 2 });
    const a = r.node({ model: Model.ESC_20A, seed: 11, num: 5 });
    const b = r.node({ model: Model.ESC_80A, seed: 12, num: 5 });
    const fresh = r.node({ model: Model.ESC_20A, seed: 13 });
    const enc = r.node({ model: Model.CYNCODER, seed: 14 });
    await run(r.sched, 1600);
    // The board that heartbeats second hears the first one and goes CONFLICT; the first keeps #5.
    expect(a.conflict !== b.conflict).toBe(true);
    const loser = a.conflict ? a : b;
    const winner = a.conflict ? b : a;
    const unresolved = r.bus.unresolved;
    expect(unresolved.map((d) => d.uid48).sort()).toEqual(
      [loser, fresh, enc].map((n) => n.uid48.toString(16).padStart(12, '0')).sort(),
    );
    expect(unresolved.find((d) => d.uid48 === r.bus.deviceByUid(fresh.uid48)?.uid48)?.unassigned).toBe(true);
    expect(r.bus.suggestNumber(2)).toBe(1);
    expect(r.bus.suggestNumber(7)).toBe(1);

    // PROTOCOL §3.4: the lowest uid48 of the #5 group keeps the number, whichever board saw the
    // conflict; the others move to the first free numbers first and the keeper is re-assigned last.
    const keeper = a.uid48 < b.uid48 ? a : b;
    const mover = keeper === a ? b : a;
    const hex = (n: { uid48: number }): string => n.uid48.toString(16).padStart(12, '0');
    const plan = r.bus.planResolve();
    expect(plan[plan.length - 1]).toMatchObject({ uid48: hex(keeper), from: 5, to: 5 });
    const moves = plan.slice(0, -1);
    expect(moves.filter((s) => s.devType === 2).map((s) => s.to)).toEqual([1, 3]);
    expect(moves.filter((s) => s.devType === 2).map((s) => s.uid48).sort()).toEqual([hex(mover), hex(fresh)].sort());
    expect(moves.find((s) => s.devType === 7)?.to).toBe(1);

    const outcome = await settle(r.sched, r.bus.resolveAll({ persist: true }));
    expect(outcome.every((o) => o.ok)).toBe(true);
    await run(r.sched, 1200);
    expect(r.bus.unresolved).toEqual([]);
    expect(keeper.num).toBe(5);
    expect(winner.conflict || loser.conflict).toBe(false);
    expect(new Set([keep.num, mover.num, fresh.num])).toEqual(new Set([1, 2, 3]));
    expect(enc.num).toBe(1);
    expect(fresh.persistedNum).not.toBeNull();
    expect(r.bus.suggestNumber(2)).toBe(4);
    // Resolved boards heartbeat again and the host reads their INFO pages.
    await r.ready(mover);
  });

  it('refuses numbers that are taken or out of range', async () => {
    const r = await rig();
    const other = r.node({ model: Model.ESC_20A, seed: 20, num: 1 });
    const n = r.node({ model: Model.ESC_20A, seed: 21, num: 2 });
    await r.ready(other);
    await r.ready(n);
    const uid = n.uid48.toString(16);
    expect(await caught(r.bus.assignId(uid, 1))).toMatchObject({ code: 'INVALID', reason: 'number_taken' });
    expect(await caught(r.bus.assignId(uid, 63))).toMatchObject({ code: 'INVALID', reason: 'out_of_range' });
    expect(await caught(r.bus.assignId('zz', 3))).toMatchObject({ code: 'INVALID', reason: 'bad_uid' });
  });

  it('times out ASSIGN_ID when the board does not confirm', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 22 });
    await run(r.sched, 300);
    expect(n.num).toBe(NUM_UNASSIGNED);
    n.powerOff();
    const before = r.bus.currentStats.enumTimeouts;
    const e = await caught(settle(r.sched, r.bus.assignId(n.uid48, 4)));
    expect(e).toMatchObject({ code: 'TIMEOUT' });
    await run(r.sched, 1000);
    expect(r.bus.currentStats.enumTimeouts).toBeGreaterThan(before);
  });

  it('identifies unassigned boards by UID and refuses addressed requests to them', async () => {
    const r = await rig();
    const n = r.node({ model: Model.SEALED_SERVO, seed: 23 });
    await run(r.sched, 300);
    const h = r.bus.deviceByUid(n.uid48);
    expect(h?.unassigned).toBe(true);
    r.bus.identifyByUid(n.uid48, 5);
    await run(r.sched, 5);
    expect(n.identifySeconds).toBe(5);
    expect(await caught(h!.getParam('ctrl.timeout_ms'))).toMatchObject({ code: 'UNRESOLVED' });
    expect(() => h!.control.set('position', 10)).toThrow(expect.objectContaining({ code: 'UNRESOLVED' }));
  });
});
