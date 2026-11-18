import { describe, expect, it } from 'vitest';
import {
  decodeCtrlServo,
  decodeCtrlSet,
  decodeCtrlText,
  decodeMessage,
  decodeStatusFrame,
  deriveUid,
  encodeMessage,
  fromHex,
  getModel,
  idIndex,
  toHex,
  validateCyfw,
  type CyCanMessage,
} from '../src';
import { buildVectors, jsonFields, messageFromJson } from './vectors/cases';
import vectors from './vectors/cycan-vectors.json';

function decodeFor(kind: string, id: number, data: Uint8Array): CyCanMessage | null {
  if (kind === 'ctrlSet') return decodeCtrlSet(data);
  if (kind === 'ctrlServo') return decodeCtrlServo(data, idIndex(id));
  if (kind === 'ctrlText') return decodeCtrlText(data);
  return decodeMessage(id, data);
}

describe('golden vectors (cycan-vectors.json)', () => {
  it('file is up to date with cases.ts (run tools/gen-vectors.ts)', () => {
    expect(JSON.parse(JSON.stringify(buildVectors()))).toEqual(vectors);
  });

  it.each(vectors.messages.map((v) => [v.name, v] as const))('%s matches the codecs', (_n, v) => {
    const id = parseInt(v.id, 16);
    const data = fromHex(v.data)!;
    const decoded = decodeFor(v.kind, id, data);
    expect(decoded).not.toBeNull();
    expect(jsonFields(decoded!)).toEqual(v.fields);
    const f = encodeMessage(v.addr, messageFromJson(v.fields));
    expect(f.id).toBe(id);
    expect(toHex(f.data)).toBe(v.data);
    expect(f.fd).toBe(v.fd);
  });

  it('uid derivations', () => {
    for (const u of vectors.uid) {
      const d = deriveUid(fromHex(u.uid96)!);
      expect({ uid48: d.uid48, uid16: d.uid16, hash10: d.hash10, enumDelayMs: d.enumDelayMs }).toEqual({
        uid48: u.uid48,
        uid16: u.uid16,
        hash10: u.hash10,
        enumDelayMs: u.enumDelayMs,
      });
      expect(parseInt(u.uid48Hex, 16)).toBe(u.uid48);
    }
  });

  it('status frames decode back to their values', () => {
    for (const s of vectors.statusFrames) {
      const frame = getModel(s.model)!.statusFrames.find((f) => f.index === s.frame)!;
      const back = decodeStatusFrame(frame, fromHex(s.data)!)!;
      for (const [k, v] of Object.entries(s.values)) expect(back[k]).toBeCloseTo(v as number, 4);
    }
  });

  it('cyfw image validates', () => {
    const v = validateCyfw(fromHex(vectors.cyfw.file)!);
    expect(v.ok).toBe(true);
    if (v.ok) expect(toHex(v.payload)).toBe(vectors.cyfw.payload);
  });
});
