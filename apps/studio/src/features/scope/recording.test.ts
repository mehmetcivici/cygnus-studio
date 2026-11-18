import { describe, expect, it } from 'vitest';
import { SessionRecorder, useRecorder } from '../../core/recorder/session';
import { buildStaticSession, parseRecording, recordingFileName, splitCsvLine, splitTitle } from './recording';

describe('CSV helpers', () => {
  it('splits quoted cells and titles with units', () => {
    expect(splitCsvLine('1.5,"a,b","say ""hi""",')).toEqual(['1.5', 'a,b', 'say "hi"', '']);
    expect(splitTitle('Sol ön · Hız [rps]')).toEqual({ label: 'Sol ön · Hız', unit: 'rps' });
    expect(splitTitle('plain')).toEqual({ label: 'plain', unit: '' });
  });
});

describe('parseRecording', () => {
  it('reads the wide CSV the recorder writes and skips empty cells', () => {
    const csv = 'time_s,"Kart, A · Hız [rps]",Akım [A]\n0.0000,1,\n0.0200,2,5\n0.0400,3,6\n';
    const rec = parseRecording(csv);
    expect(rec?.channels).toHaveLength(2);
    expect(rec?.channels[0]).toMatchObject({ label: 'Kart, A · Hız', unit: 'rps', t: [0, 0.02, 0.04], v: [1, 2, 3] });
    expect(rec?.channels[1]).toMatchObject({ label: 'Akım', unit: 'A', t: [0.02, 0.04], v: [5, 6] });
  });

  it('reads the JSON recording', () => {
    const json = JSON.stringify({ format: 'cygnus-recording', version: 1, channels: [{ uid48: 'a', key: 'k', label: 'L', unit: 'V', t_ms: [0, 1000], v: [1, null] }] });
    const rec = parseRecording(json);
    expect(rec?.channels[0]?.t).toEqual([0, 1]);
    expect(rec?.channels[0]?.v[0]).toBe(1);
    expect(rec?.channels[0]?.v[1]).toBeNaN();
  });

  it('rejects other files', () => {
    expect(parseRecording('hello')).toBeNull();
    expect(parseRecording('{"format":"other"}')).toBeNull();
    expect(parseRecording('a,b\n1,2')).toBeNull();
  });

  it('round-trips what the session recorder exports', () => {
    const listeners: Array<(u: { t: number; keys: string[]; values: Record<string, number> }) => void> = [];
    const handle = { onSignals: (cb: (typeof listeners)[number]) => (listeners.push(cb), () => undefined) };
    let clock = 1000;
    const rec = new SessionRecorder(useRecorder, () => clock);
    rec.setResolver(() => handle as never);
    rec.start([{ uid48: 'a', key: 'velocity', label: 'Sol · Hız', unit: 'rps' }]);
    for (let i = 0; i < 4; i++) {
      clock += 20;
      for (const l of listeners) l({ t: 500 + i * 20, keys: ['velocity'], values: { velocity: i * 1.5 } });
    }
    rec.stop();
    for (const text of [rec.toCSV(), rec.toJSON()]) {
      const parsed = parseRecording(text);
      expect(parsed?.channels[0]?.label).toBe('Sol · Hız');
      expect(parsed?.channels[0]?.unit).toBe('rps');
      expect(parsed?.channels[0]?.v).toEqual([0, 1.5, 3, 4.5]);
      expect(parsed?.channels[0]?.t[3]).toBeCloseTo(0.06, 6);
    }
  });
});

describe('static session', () => {
  it('groups channels into panes by unit and fills buffers', () => {
    const s = buildStaticSession('x.csv', {
      channels: [
        { label: 'a', unit: 'V', t: [0, 1, 2], v: [1, 2, 3] },
        { label: 'b', unit: 'A', t: [0, 2], v: [0, 4] },
        { label: 'c', unit: 'V', t: [1], v: [9] },
      ],
    });
    expect(s.layout.panes).toEqual(['p1', 'p2']);
    expect(s.layout.signals.map((x) => x.pane)).toEqual(['p1', 'p2', 'p1']);
    expect(s.buffers.get('rec/0')?.length).toBe(3);
    expect(s.extent).toEqual([0, 2]);
    expect(s.samples).toBe(6);
  });

  it('names export files with a timestamp', () => {
    expect(recordingFileName('csv', new Date(2026, 3, 2, 5, 6, 7))).toBe('cygnus-scope-20260402-050607.csv');
  });
});
