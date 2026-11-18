import { Model } from '@cygnus/protocol';
import { makeDemoFirmware } from '@cygnus/simulator';
import { describe, expect, it } from 'vitest';
import {
  assessCard,
  buildDate,
  cmpVersion,
  compatibleImages,
  imageCompat,
  isDowngrade,
  parseImage,
  parseVersion,
  transferRate,
  type CardInfo,
  type FwImage,
} from './logic';

function img(model: number, v: string, o: { hwMin?: number; hwMax?: number } = {}): FwImage {
  const r = parseImage(`${model}-${v}.cyfw`, makeDemoFirmware(model, v, { hwRevMin: o.hwMin ?? 1, hwRevMax: o.hwMax ?? 3 }));
  if (!r.ok) throw new Error(r.error);
  return r.image;
}

const card = (o: Partial<CardInfo> = {}): CardInfo => ({
  model: Model.ESC_80A,
  hwRev: 2,
  online: true,
  legacy: false,
  firmwareCapable: true,
  bootloader: false,
  fw: { major: 1, minor: 0, patch: 0 },
  ...o,
});

describe('versions', () => {
  it('parses and compares numerically, not lexically', () => {
    expect(parseVersion('1.10.2')).toEqual({ major: 1, minor: 10, patch: 2 });
    expect(parseVersion('1.x')).toBeNull();
    expect(cmpVersion({ major: 1, minor: 10, patch: 0 }, { major: 1, minor: 9, patch: 9 })).toBeGreaterThan(0);
    expect(cmpVersion({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 99, patch: 99 })).toBeGreaterThan(0);
    expect(cmpVersion({ major: 1, minor: 2, patch: 3 }, { major: 1, minor: 2, patch: 3 })).toBe(0);
  });

  it('converts build days to dates', () => {
    expect(buildDate(0)).toBe('2026-01-01');
    expect(buildDate(320)).toBe('2026-11-17');
  });
});

describe('image parsing', () => {
  it('reads the header of a valid image', () => {
    const r = parseImage('a.cyfw', makeDemoFirmware(Model.ESC_80A, '1.1.0'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.image.header).toMatchObject({ model: Model.ESC_80A, fwMajor: 1, fwMinor: 1, fwPatch: 0, hwRevMin: 1, hwRevMax: 3 });
    }
  });

  it('names the problem in broken files', () => {
    const good = makeDemoFirmware(Model.ESC_80A, '1.1.0');
    expect(parseImage('x', new Uint8Array(10))).toMatchObject({ ok: false, error: 'too_short' });
    expect(parseImage('x', new Uint8Array(100))).toMatchObject({ ok: false, error: 'bad_magic' });
    expect(parseImage('x', good.subarray(0, good.length - 5))).toMatchObject({ ok: false, error: 'size_mismatch' });
    const flipped = good.slice();
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff;
    expect(parseImage('x', flipped)).toMatchObject({ ok: false, error: 'bad_payload_crc' });
    const hdr = good.slice();
    hdr[9] = 9;
    expect(parseImage('x', hdr)).toMatchObject({ ok: false, error: 'bad_header_crc' });
  });

  it('gives different ids to different builds', () => {
    expect(img(2, '1.1.0').id).not.toBe(img(2, '1.2.0').id);
  });
});

describe('compatibility', () => {
  it('checks model and hardware range', () => {
    const i = img(Model.ESC_80A, '1.1.0', { hwMin: 2, hwMax: 3 });
    expect(imageCompat(i, { model: Model.ESC_80A, hwRev: 2 })).toBe('ok');
    expect(imageCompat(i, { model: Model.ESC_80A, hwRev: 1 })).toBe('wrong_hw_rev');
    expect(imageCompat(i, { model: Model.ESC_20A, hwRev: 2 })).toBe('wrong_model');
    expect(imageCompat(i, { model: Model.ESC_80A, hwRev: null })).toBe('ok');
  });

  it('lists compatible images newest first', () => {
    const list = compatibleImages([img(2, '1.1.0'), img(2, '1.10.0'), img(2, '1.2.0'), img(3, '9.0.0')], { model: 2, hwRev: 1 });
    expect(list.map((i) => `${i.header.fwMajor}.${i.header.fwMinor}`)).toEqual(['1.10', '1.2', '1.1']);
  });
});

describe('card status', () => {
  const lib = [img(Model.ESC_80A, '1.1.0'), img(Model.ESC_80A, '1.2.0')];

  it('update available picks the newest image', () => {
    const a = assessCard(card(), lib);
    expect(a.status).toBe('updateAvailable');
    expect(a.best?.header.fwMinor).toBe(2);
  });

  it('up to date, ahead and unknown version', () => {
    expect(assessCard(card({ fw: { major: 1, minor: 2, patch: 0 } }), lib).status).toBe('upToDate');
    expect(assessCard(card({ fw: { major: 1, minor: 3, patch: 0 } }), lib).status).toBe('ahead');
    expect(assessCard(card({ fw: null }), lib).status).toBe('updateAvailable');
  });

  it('no image vs incompatible hardware', () => {
    expect(assessCard(card({ model: Model.CYNCODER }), lib).status).toBe('noImage');
    expect(assessCard(card({ hwRev: 7 }), lib).status).toBe('hwIncompatible');
    expect(assessCard(card(), []).status).toBe('noImage');
  });

  it('bootloader, legacy and offline win over version comparison', () => {
    expect(assessCard(card({ bootloader: true, fw: { major: 0, minor: 0, patch: 0 } }), lib)).toMatchObject({ status: 'bootloader' });
    expect(assessCard(card({ legacy: true, firmwareCapable: false }), lib).status).toBe('legacy');
    expect(assessCard(card({ online: false }), lib).status).toBe('offline');
  });
});

describe('downgrade and throughput', () => {
  it('flags older images but not on an erased board', () => {
    const old = img(2, '1.0.0');
    expect(isDowngrade({ major: 1, minor: 2, patch: 0 }, old)).toBe(true);
    expect(isDowngrade({ major: 1, minor: 0, patch: 0 }, old)).toBe(false);
    expect(isDowngrade({ major: 0, minor: 0, patch: 0 }, old)).toBe(false);
    expect(isDowngrade(null, old)).toBe(false);
  });

  it('computes speed and remaining time', () => {
    expect(transferRate(2000, 8000, 1000)).toEqual({ rateKBs: 2, etaS: 3 });
    expect(transferRate(0, 8000, 1000)).toEqual({ rateKBs: 0, etaS: null });
  });
});
