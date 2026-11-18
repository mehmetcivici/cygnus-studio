import {
  CATALOG,
  Cls,
  MFR,
  SysRsp,
  decodeStatusFrame,
  idClass,
  idDevType,
  idIndex,
  idMfr,
  idNum,
  readU16,
  type ModelDef,
} from '@cygnus/protocol';
import type { BusFrame } from '../bus';
import { NodeMode, SimNode, type SimNodeOptions } from '../node';
import { FONT5X7 } from './font5x7';

export const OLED_WIDTH = 128;
export const OLED_HEIGHT = 64;
const COLS = 21;
const ROWS = 8;
const RENDER_MS = 100;

const DEVTYPE_SHORT: Record<number, string> = { 2: 'MOT', 4: 'GYR', 7: 'ENC', 8: 'PWR', 10: 'MSC', 12: 'SRV' };

interface Seen {
  devType: number;
  num: number;
  lastMs: number;
  fault: number;
  state: number;
}

export type OledPage = 'text' | 'watch' | 'overview';

/**
 * CAN debug OLED: 128×64 monochrome panel. Draws text written over CTRL, four watch slots
 * fed from other boards' STATUS frames, and an overview of boards seen on the bus.
 * The framebuffer uses SSD1306 page layout (8 pages × 128 columns, bit 0 = top row).
 */
export class OledNode extends SimNode {
  readonly framebuffer = new Uint8Array((OLED_WIDTH * OLED_HEIGHT) / 8);
  /** Bumped on every redraw so a UI can skip unchanged frames. */
  frameVersion = 0;
  private readonly text: Uint8Array = new Uint8Array(COLS * ROWS).fill(0x20);
  private readonly seen = new Map<number, Seen>();
  private readonly models = new Map<number, number>();
  private readonly watchData: Array<Uint8Array | null> = [null, null, null, null];
  private readonly watchAt = new Float64Array(4);
  private page: OledPage = 'text';
  private pageSince = 0;
  private nextRender = 0;
  private errorBase = 0;
  protected override readonly listensToPeers = true;
  private readonly P: Record<string, number>;
  private readonly S: Record<string, number>;

  constructor(o: SimNodeOptions = {}) {
    super(10, o);
    const keys = ['oled.brightness', 'oled.rotation', 'oled.page_s', 'oled.overview_enable'];
    for (let w = 1; w <= 4; w++) keys.push(`watch.${w}.devtype`, `watch.${w}.num`, `watch.${w}.frame`, `watch.${w}.field`);
    this.P = Object.fromEntries(keys.map((k) => [k, this.params.index(k)]));
    this.S = Object.fromEntries(['bus.devices', 'bus.load', 'bus.error_frames'].map((k) => [k, this.sigIndex(k)]));
  }

  private pk(k: string): number {
    return this.p(this.P[k]!);
  }

  /** Watch slot settings (devtype, num, frame, field) × 4, refreshed when parameters change. */
  private readonly watchCfg = new Int32Array(16);
  private watchVer = -1;

  private syncWatch(): void {
    if (this.watchVer === this.params.version) return;
    this.watchVer = this.params.version;
    for (let w = 0; w < 4; w++) {
      this.watchCfg[w * 4] = this.pk(`watch.${w + 1}.devtype`);
      this.watchCfg[w * 4 + 1] = this.pk(`watch.${w + 1}.num`);
      this.watchCfg[w * 4 + 2] = this.pk(`watch.${w + 1}.frame`);
      this.watchCfg[w * 4 + 3] = this.pk(`watch.${w + 1}.field`);
    }
  }

  protected override onAppStart(): void {
    this.text.fill(0x20);
    this.seen.clear();
    this.watchData.fill(null);
    this.page = 'text';
    this.pageSince = this.now;
    this.errorBase = this.ctx.bus.stats.errorFrames;
  }

  protected override onAppStop(): void {
    this.framebuffer.fill(0);
    this.frameVersion++;
  }

  protected override onCtrl(index: number, d: Uint8Array, len: number): boolean {
    if (index !== 0 || len < 2) return false;
    const line = d[0] ?? 0;
    const col = d[1] ?? 0;
    if (line >= ROWS) return false;
    for (let i = 0; i < 6 && 2 + i < len; i++) {
      const c = d[2 + i] ?? 0;
      if (c === 0 || col + i >= COLS) continue;
      this.text[line * COLS + col + i] = c >= 0x20 && c < 0x7f ? c : 0x3f;
    }
    return true;
  }

  protected override onPeerFrame(f: BusFrame): void {
    const id = f.id;
    if (idMfr(id) !== MFR) return;
    const cls = idClass(id);
    const dt = idDevType(id);
    if (cls === Cls.SYS_RSP && idIndex(id) === SysRsp.HEARTBEAT && f.len >= 8) {
      const key = (dt << 6) | idNum(id);
      const s = this.seen.get(key);
      const state = (f.data[0] ?? 0) & 0x0f;
      const fault = readU16(f.data, 1);
      if (s) {
        s.lastMs = this.now;
        s.fault = fault;
        s.state = state;
      } else this.seen.set(key, { devType: dt, num: idNum(id), lastMs: this.now, fault, state });
    } else if (cls === Cls.ENUM_RSP && f.len >= 8) {
      // Learn models so watch fields decode with the right catalog layout.
      this.models.set((dt << 6) | ((f.data[6] ?? 0) & 0x3f), f.data[7] ?? 0);
    } else if (cls === Cls.STATUS) {
      this.syncWatch();
      const wc = this.watchCfg;
      for (let w = 0; w < 4; w++) {
        const wdt = wc[w * 4]!;
        if (wdt === 0 || wdt !== dt || wc[w * 4 + 1] !== idNum(id) || wc[w * 4 + 2] !== idIndex(id)) continue;
        let buf = this.watchData[w];
        if (!buf) buf = this.watchData[w] = new Uint8Array(8);
        for (let i = 0; i < 8; i++) buf[i] = f.data[i] ?? 0;
        this.watchAt[w] = this.now;
      }
    }
  }

  protected override appTick(): void {
    const now = this.now;
    let devices = 0;
    for (const s of this.seen.values()) if (now - s.lastMs < 1500) devices++;
    const st = this.ctx.bus.stats;
    this.sig[this.S['bus.devices']!] = devices;
    this.sig[this.S['bus.load']!] = st.load * 100;
    this.sig[this.S['bus.error_frames']!] = st.errorFrames - this.errorBase;
    if (now < this.nextRender) return;
    this.nextRender = now + RENDER_MS;
    this.choosePage();
    this.render();
  }

  private pages(): OledPage[] {
    const out: OledPage[] = ['text'];
    if ([1, 2, 3, 4].some((w) => this.pk(`watch.${w}.devtype`) !== 0)) out.push('watch');
    if (this.pk('oled.overview_enable')) out.push('overview');
    return out;
  }

  private choosePage(): void {
    const pages = this.pages();
    const textEmpty = this.text.every((c) => c === 0x20);
    if (!pages.includes(this.page)) this.page = pages[0]!;
    const per = this.pk('oled.page_s');
    if (per > 0 && pages.length > 1 && this.now - this.pageSince >= per * 1000) {
      this.page = pages[(pages.indexOf(this.page) + 1) % pages.length]!;
      this.pageSince = this.now;
    } else if (per === 0 && textEmpty && pages.length > 1 && this.page === 'text') {
      this.page = pages[1]!;
    }
  }

  private render(): void {
    const fb = this.framebuffer;
    fb.fill(0);
    if (this.mode !== NodeMode.APP) return;
    const lines = this.pageLines();
    for (let r = 0; r < ROWS; r++) {
      const line = lines[r] ?? '';
      for (let c = 0; c < COLS && c < line.length; c++) this.drawChar(c * 6, r, line.charCodeAt(c));
    }
    if (this.page === 'text') {
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) this.drawChar(c * 6, r, this.text[r * COLS + c]!);
    }
    if (this.identifying && Math.floor(this.now / 250) % 2 === 0) for (let i = 0; i < fb.length; i++) fb[i] = ~fb[i]! & 0xff;
    if (this.pk('oled.rotation') === 1) this.rotate180();
    this.frameVersion++;
  }

  private pageLines(): string[] {
    if (this.page === 'text') return [];
    if (this.page === 'overview') {
      const st = this.ctx.bus.stats;
      const out = [`BUS ${(st.load * 100).toFixed(0).padStart(3)}% ERR ${this.sig[this.S['bus.error_frames']!]}`];
      const list = [...this.seen.values()].filter((s) => this.now - s.lastMs < 1500).sort((a, b) => a.devType - b.devType || a.num - b.num);
      for (const s of list.slice(0, 7)) {
        const tag = s.fault ? `F${s.fault.toString(16).toUpperCase()}` : 'OK';
        out.push(`${DEVTYPE_SHORT[s.devType] ?? 'DEV'}#${String(s.num).padEnd(2)} ${tag}`);
      }
      return out;
    }
    const out = ['WATCH'];
    for (let w = 0; w < 4; w++) {
      const dt = this.pk(`watch.${w + 1}.devtype`);
      if (dt === 0) continue;
      const num = this.pk(`watch.${w + 1}.num`);
      const label = `${DEVTYPE_SHORT[dt] ?? 'DEV'}#${num}`;
      const data = this.watchData[w];
      if (!data || this.now - this.watchAt[w]! > 1000) {
        out.push(`${label} --`);
        continue;
      }
      const v = this.watchValue(dt, num, this.pk(`watch.${w + 1}.frame`), this.pk(`watch.${w + 1}.field`), data);
      out.push(`${label} ${v}`);
    }
    return out;
  }

  private watchValue(dt: number, num: number, frame: number, field: number, data: Uint8Array): string {
    const model = this.models.get((dt << 6) | num);
    const def: ModelDef | undefined = CATALOG.find((m) => m.model === model) ?? CATALOG.find((m) => m.devType === dt);
    const fd = def?.statusFrames.find((f) => f.index === frame);
    const fl = fd?.fields[field];
    if (!fd || !fl) return '?';
    const vals = decodeStatusFrame(fd, data);
    const v = vals?.[fl.signal] ?? 0;
    const sig = def?.signals.find((s) => s.key === fl.signal);
    const short = fl.signal.split('.').pop()!.slice(0, 6);
    return `${short} ${v.toFixed(Math.min(2, sig?.digits ?? 1))}${sig?.unit && sig.unit.length <= 3 ? sig.unit : ''}`.slice(0, 14);
  }

  private drawChar(x: number, row: number, code: number): void {
    const g = code >= 0x20 && code < 0x7f ? code - 0x20 : 0x1f;
    const base = row * OLED_WIDTH + x;
    for (let c = 0; c < 5; c++) this.framebuffer[base + c] = FONT5X7[g * 5 + c] ?? 0;
  }

  private rotate180(): void {
    const fb = this.framebuffer;
    const n = fb.length;
    for (let i = 0; i < n / 2; i++) {
      const a = reverseBits(fb[i]!);
      fb[i] = reverseBits(fb[n - 1 - i]!);
      fb[n - 1 - i] = a;
    }
  }

  /** Pixel at (x, y), true = lit. */
  pixel(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= OLED_WIDTH || y >= OLED_HEIGHT) return false;
    return ((this.framebuffer[(y >> 3) * OLED_WIDTH + x]! >> (y & 7)) & 1) === 1;
  }

  /** Text written over CTRL, one string per line. */
  textLines(): string[] {
    const out: string[] = [];
    for (let r = 0; r < ROWS; r++) out.push(String.fromCharCode(...this.text.subarray(r * COLS, (r + 1) * COLS)).trimEnd());
    return out;
  }

  get currentPage(): OledPage {
    return this.page;
  }

  /** Panel brightness 0..1 (the UI dims the rendering). */
  get brightness(): number {
    return this.pk('oled.brightness') / 100;
  }

  override supplyCurrent(): number {
    return this.mode === NodeMode.OFF ? 0 : 0.03 + 0.0004 * this.pk('oled.brightness');
  }
}

function reverseBits(b: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
  return r;
}

/** USB-CAN adapter as a board on the bus: identity, switchable termination, nothing else. */
export class UsbCanNode extends SimNode {
  constructor(o: SimNodeOptions = {}) {
    super(11, o);
  }
}
