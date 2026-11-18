import { describe, expect, it } from 'vitest';
import { RowDecodeCache } from './rowCache';

class Ring {
  frames: { seq: number; v: number }[] = [];
  totalSeen = 0;
  constructor(private cap: number) {}
  push(v: number): void {
    this.frames.push({ seq: this.totalSeen++, v });
    if (this.frames.length > this.cap) this.frames.shift();
  }
  get length(): number {
    return this.frames.length;
  }
  get(i: number) {
    return this.frames[i];
  }
}

describe('RowDecodeCache (CAN monitor stream at 25 boards, uygulama #15)', () => {
  it('decodes each visible frame once across refreshes, also after the ring wrapped', () => {
    const ring = new Ring(100);
    let calls = 0;
    const cache = new RowDecodeCache((f: { seq: number; v: number }) => (calls++, `d${f.v}`));
    for (let refresh = 0; refresh < 50; refresh++) {
      for (let k = 0; k < 40; k++) ring.push(refresh * 40 + k);
      const view = cache.view(ring);
      // the table shows the last 30 rows
      for (let seq = ring.totalSeen - 30; seq < ring.totalSeen; seq++) expect(view.info(seq)?.desc).toBe(`d${seq}`);
    }
    // 30 rows on the first refresh, then only rows that were not shown before (≤ 40 per refresh minus overlap)
    expect(calls).toBe(30 + 49 * 30);
    // a second pass over the same window decodes nothing
    const before = calls;
    const view = cache.view(ring);
    for (let seq = ring.totalSeen - 30; seq < ring.totalSeen; seq++) view.info(seq);
    expect(calls).toBe(before);
  });

  it('returns null for frames that left the ring and stays bounded', () => {
    const ring = new Ring(10);
    const cache = new RowDecodeCache((f: { seq: number; v: number }) => f.v, 20);
    for (let i = 0; i < 100; i++) {
      ring.push(i);
      cache.view(ring).info(i);
    }
    expect(cache.view(ring).info(95)?.desc).toBe(95);
    expect(cache.view(ring).info(0)?.desc ?? null).toBeNull();
  });
});
