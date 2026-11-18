import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROADCAST_ALL, CATALOG, Cls, ESTOP_REPEAT_COUNT, decodeStatusFrame, encodeEstop, encodeId, encodeIdentify, encodeStatusFrame, messageId, type ModelDef } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import { ARDUINO_DECODE_BEGIN, ARDUINO_DECODE_END, ESTOP_DATA, ESTOP_ID, canId, frameIds, genArduino, genCHeader, genPython, identOf, nameCards, type CodeCard, type CodeText } from './codegen';

const TEXT: CodeText = { notice: ['NOTICE: no Cygnus host library exists yet; constants and raw frames only.'], source: 'test' };

function cardOf(def: ModelDef, num: number, name = ''): CodeCard {
  return { name, devType: def.devType, num, model: def.model, modelKey: def.key, def };
}
const ALL = CATALOG.map((d, i) => cardOf(d, i + 1, `Kart ${d.key}`));

const has = (cmd: string): boolean => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;

describe('identifier math (PROTOCOL §2)', () => {
  it('matches the protocol codec for every field combination', () => {
    for (const devType of [0, 2, 4, 7, 8, 10, 12, 31]) {
      for (const cls of [0x10, 0x11, 0x12, 0x13, 0x18, 0x19, 0x1b, 0x3f]) {
        for (const index of [0, 1, 5, 15]) {
          for (const num of [0, 1, 17, 62, 63]) {
            expect(canId(devType, cls, index, num)).toBe(encodeId({ devType, cls, index, num }));
          }
        }
      }
    }
  });

  it('frame ids equal the codec message ids', () => {
    for (const c of ALL) {
      const ids = frameIds(c);
      for (const s of ids.statusIds) expect(s.id).toBe(messageId({ devType: c.devType, num: c.num }, Cls.STATUS, s.index));
      for (const s of ids.ctrlIds) expect(s.id).toBe(messageId({ devType: c.devType, num: c.num }, Cls.CTRL, s.index));
      expect(ids.identify).toBe(encodeIdentify({ devType: c.devType, num: c.num }, { seconds: 3 }).id);
      expect(ids.heartbeat).toBe(messageId({ devType: c.devType, num: c.num }, Cls.SYS_RSP, 0));
    }
  });
});

describe('names', () => {
  it('makes valid, unique identifiers from Turkish board names', () => {
    expect(identOf('Sol ön itici', 'x')).toBe('SOL_ON_ITICI');
    expect(identOf('Şişe-ğüçlü İ', 'x')).toBe('SISE_GUCLU_I');
    expect(identOf('', 'esc80a_3')).toBe('ESC80A_3');
    expect(identOf('3. kol', 'x')).toBe('_3_KOL');
    const named = nameCards([cardOf(CATALOG[0] as ModelDef, 1, 'Sol'), cardOf(CATALOG[0] as ModelDef, 2, 'sol'), cardOf(CATALOG[0] as ModelDef, 3, 'SOL')]);
    expect(named.map((n) => n.ident)).toEqual(['SOL', 'SOL_2', 'SOL_3']);
  });
});

describe('C header', () => {
  const header = genCHeader(ALL, TEXT);
  const define = (name: string): number => {
    const m = new RegExp(`^#define ${name} (0x[0-9A-Fa-f]+|\\d+)u`, 'm').exec(header);
    if (!m) throw new Error(`missing ${name}`);
    return Number(m[1]);
  };

  it('states that no host library exists and calls none', () => {
    expect(header).toContain('no Cygnus host library');
    expect(header).not.toMatch(/\bcygnus_[a-z_]+\(/);
  });

  it('carries DEVTYPE / NUM and every frame id exactly as the codec computes them', () => {
    for (const c of nameCards(ALL)) {
      expect(define(`${c.ident}_DEVTYPE`)).toBe(c.devType);
      expect(define(`${c.ident}_NUM`)).toBe(c.num);
      expect(define(`${c.ident}_MODEL`)).toBe(c.model);
      for (const f of c.def?.statusFrames ?? []) expect(define(`${c.ident}_ID_STATUS${f.index}`)).toBe(messageId({ devType: c.devType, num: c.num }, Cls.STATUS, f.index));
      for (const f of c.def?.controls ?? []) expect(define(`${c.ident}_ID_CTRL${f.index}`)).toBe(messageId({ devType: c.devType, num: c.num }, Cls.CTRL, f.index));
      expect(define(`${c.ident}_ID_IDENTIFY`)).toBe(encodeIdentify({ devType: c.devType, num: c.num }, { seconds: 3 }).id);
    }
  });

  it('the CYGNUS_ID macro text computes the same identifier', () => {
    const body = /#define CYGNUS_ID\(devtype, cls, index, num\) \\\n([\s\S]*?)\n#define CYGNUS_ID_DEVTYPE/.exec(header)?.[1] ?? '';
    const js = body.replace(/\\\n/g, ' ').replace(/\(uint32_t\)/g, '').replace(/(0x[0-9A-Fa-f]+|\d+)u\b/g, '$1').replace('CYGNUS_MFR', String(define('CYGNUS_MFR')));
    const fn = new Function('devtype', 'cls', 'index', 'num', `return (${js}) >>> 0;`) as (a: number, b: number, c: number, d: number) => number;
    for (const [dt, cls, idx, num] of [[2, 0x11, 0, 3], [12, 0x12, 2, 62], [8, 0x10, 15, 1], [0, 0x1b, 7, 0]] as const) {
      expect(fn(dt, cls, idx, num)).toBe(encodeId({ devType: dt, cls, index: idx, num }));
    }
  });
});

describe('Arduino and Python skeletons', () => {
  const arduino = genArduino(ALL, TEXT);
  const python = genPython(ALL, TEXT);

  it('only use the standard and the named third-party libraries', () => {
    expect([...arduino.matchAll(/^#include [<"](.+?)[>"]/gm)].map((m) => m[1])).toEqual(['SPI.h', 'mcp2515.h', 'string.h', 'cygnus_ids.h']);
    expect(new Set([...python.matchAll(/^\s*(?:import|from) (\w+)/gm)].map((m) => m[1]))).toEqual(new Set(['struct', 'time', 'can']));
    expect(arduino).toContain('no Cygnus host library');
    expect(python).toContain('no Cygnus host library');
    expect(arduino).toContain('autowp/arduino-mcp2515');
    expect(python).toContain('python-can');
  });

  it('builds the IDENTIFY example frame from the header constant and a 1-byte payload', () => {
    const first = nameCards(ALL)[0];
    expect(arduino).toContain(`tx.can_id = ${first?.ident}_ID_IDENTIFY | CAN_EFF_FLAG;`);
    const frame = encodeIdentify({ devType: first?.devType ?? 0, num: first?.num ?? 0 }, { seconds: 3 });
    expect(Array.from(frame.data)).toEqual([3]);
    expect(arduino).toContain('tx.data[0] = 3;');
    expect(arduino).toContain('tx.can_dlc = 1;');
  });

  // Executed for real: the generated decoders must reproduce the protocol codec on every STATUS frame.
  const cases = CATALOG.flatMap((def) =>
    def.statusFrames.map((f) => {
      const values: Record<string, number> = {};
      f.fields.forEach((fld, i) => {
        const sd = def.signals.find((s) => s.key === fld.signal);
        const [lo, hi] = sd?.range ?? [0, 1];
        values[fld.signal] = lo + ((hi - lo) * ((i * 37 + def.model * 11 + f.index * 5) % 100)) / 100;
      });
      const bytes = encodeStatusFrame(f, values);
      return { model: def.key, index: f.index, bytes: Array.from(bytes), expected: decodeStatusFrame(f, bytes) as Record<string, number> };
    }),
  );
  const sigName = (k: string): string => k.replace(/[^A-Za-z0-9]+/g, '_');
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b));

  it.skipIf(!has('python3'))('python decoder and ids reproduce the codec', () => {
    const harness = `
import json, sys
ns = {"__name__": "generated"}
exec(open(sys.argv[1]).read(), ns)
cases = json.loads(sys.stdin.read())
out = [ns["decode_status"](c["model"], c["index"], bytes(c["bytes"])) for c in cases]
ids = {k: [ns["can_id"](d["devtype"], ns["CLS_STATUS"], 0, d["num"]), ns["can_id"](d["devtype"], ns["CLS_SYS_REQ"], ns["SYS_REQ_IDENTIFY"], d["num"])] for k, d in ns["DEVICES"].items()}
print(json.dumps({"out": out, "ids": ids}))
`;
    const dir = mkdtempSync(join(tmpdir(), 'cygnus-py-'));
    writeFileSync(join(dir, 'generated.py'), python);
    const r = spawnSync('python3', ['-I', '-c', harness, join(dir, 'generated.py')], { input: JSON.stringify(cases), encoding: 'utf8' });
    expect(r.stderr).toBe('');
    const res = JSON.parse(r.stdout) as { out: Array<Record<string, number>>; ids: Record<string, number[]> };
    cases.forEach((c, i) => {
      for (const [k, v] of Object.entries(c.expected)) expect(near(res.out[i]?.[sigName(k)] ?? NaN, v), `${c.model}/${c.index}/${k}`).toBe(true);
    });
    for (const c of nameCards(ALL)) {
      expect(res.ids[c.ident]).toEqual([messageId({ devType: c.devType, num: c.num }, Cls.STATUS, 0), encodeIdentify({ devType: c.devType, num: c.num }, { seconds: 3 }).id]);
    }
  });

  it.skipIf(!has('g++'))('C++ decoder reproduces the codec', () => {
    const begin = arduino.indexOf(ARDUINO_DECODE_BEGIN);
    const end = arduino.indexOf(ARDUINO_DECODE_END);
    expect(begin).toBeGreaterThan(0);
    const region = arduino.slice(begin, end);
    const dispatch = CATALOG.flatMap((d) => d.statusFrames.map((f) => `if (m == "${d.key}" && idx == ${f.index}) { t = ${d.key.toUpperCase()}_STATUS${f.index}; n = ${d.key.toUpperCase()}_STATUS${f.index}_COUNT; }`)).join('\n    ');
    const src = `#include <stdint.h>\n#include <string.h>\n#include <stdio.h>\n#include <string>\n${region}\nint main() {\n  char model[64]; int idx; unsigned b[8];\n  while (scanf("%63s %d %x %x %x %x %x %x %x %x", model, &idx, &b[0], &b[1], &b[2], &b[3], &b[4], &b[5], &b[6], &b[7]) == 10) {\n    std::string m(model); const CyField *t = 0; uint8_t n = 0;\n    ${dispatch}\n    uint8_t d[8]; for (int i = 0; i < 8; i++) d[i] = (uint8_t)b[i];\n    for (uint8_t i = 0; i < n; i++) printf("%s=%.9g ", t[i].name, (double)cyDecode(d, t[i]));\n    printf("\\n");\n  }\n}\n`;
    const dir = mkdtempSync(join(tmpdir(), 'cygnus-cpp-'));
    writeFileSync(join(dir, 'decode.cpp'), src);
    const cc = spawnSync('g++', ['-std=c++11', '-Wall', '-Werror', '-o', join(dir, 'decode'), join(dir, 'decode.cpp')], { encoding: 'utf8' });
    expect(cc.stderr).toBe('');
    const input = cases.map((c) => `${c.model} ${c.index} ${c.bytes.map((b) => b.toString(16)).join(' ')}`).join('\n') + '\n';
    const run = spawnSync(join(dir, 'decode'), [], { input, encoding: 'utf8' });
    const lines = run.stdout.trim().split('\n');
    cases.forEach((c, i) => {
      const got = Object.fromEntries((lines[i] ?? '').trim().split(' ').map((kv) => kv.split('=') as [string, string]));
      for (const [k, v] of Object.entries(c.expected)) expect(near(Number(got[sigName(k)]), v), `${c.model}/${c.index}/${k}`).toBe(true);
    });
    expect(readFileSync(join(dir, 'decode.cpp'), 'utf8')).toContain('cyDecode');
  });
});

describe('safety rules in the generated code (PROTOCOL 4.7, 7)', () => {
  it('ESTOP constants match the protocol codec', () => {
    const f = encodeEstop(BROADCAST_ALL);
    expect(ESTOP_ID).toBe(f.id);
    expect([...ESTOP_DATA]).toEqual([...f.data]);
    const h = genCHeader(ALL, TEXT);
    expect(h).toContain(`#define CYGNUS_ESTOP_REPEAT ${ESTOP_REPEAT_COUNT}u`);
  });

  it('Arduino and Python send ESTOP three times and start driving from neutral', () => {
    const ino = genArduino(ALL, TEXT);
    expect(ino).toMatch(/for \(uint8_t i = 0; i < CYGNUS_ESTOP_REPEAT; i\+\+\)/);
    expect(ino).toContain('cyNeutral(');
    // the example never sends a non-neutral command
    expect(ino).not.toMatch(/^\s*cySet\(/m);
    const py = genPython(ALL, TEXT);
    expect(py).toContain('for i in range(ESTOP_REPEAT):');
    expect(py).toContain('ESTOP_REPEAT = 3');
    expect(py).toMatch(/^\s{8}neutral\(bus, DEVICES\[/m);
    expect(py).not.toMatch(/^\s{8}ctrl_set\(/m);
  });
});
