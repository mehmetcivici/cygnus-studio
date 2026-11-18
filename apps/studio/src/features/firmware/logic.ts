import { validateCyfw, type CyfwError, type CyfwHeader, type FwVersion } from '@cygnus/protocol';

export interface Ver {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(s: string): Ver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function fmtVersion(v: Ver | null | undefined): string {
  return v ? `${v.major}.${v.minor}.${v.patch}` : '—';
}

/** Negative when `a` is older than `b`. */
export function cmpVersion(a: Ver, b: Ver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export const imageVersion = (h: Pick<CyfwHeader, 'fwMajor' | 'fwMinor' | 'fwPatch'>): Ver => ({ major: h.fwMajor, minor: h.fwMinor, patch: h.fwPatch });

/** A bootloader without a valid application reports 0.0.0. */
export const isEmptyVersion = (v: Ver | null): boolean => v !== null && v.major === 0 && v.minor === 0 && v.patch === 0;

export interface FwImage {
  id: string;
  fileName: string;
  bytes: Uint8Array;
  header: CyfwHeader;
  fileCrc32: number;
}

export type ImageParse = { ok: true; image: FwImage } | { ok: false; fileName: string; error: CyfwError; header: CyfwHeader | null };

/** Header + payload checks (no target), so a broken file is named before any board is touched. */
export function parseImage(fileName: string, bytes: Uint8Array): ImageParse {
  const v = validateCyfw(bytes);
  if (!v.ok) return { ok: false, fileName, error: v.error, header: v.header };
  const h = v.header;
  const id = `${h.model}:${h.fwMajor}.${h.fwMinor}.${h.fwPatch}:${v.fileCrc32.toString(16)}`;
  return { ok: true, image: { id, fileName, bytes, header: h, fileCrc32: v.fileCrc32 } };
}

/** Days since 2026-01-01 → ISO date. */
export function buildDate(day: number): string {
  return new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
}

export interface Target {
  model: number;
  hwRev: number | null;
}

export type Compat = 'ok' | 'wrong_model' | 'wrong_hw_rev';

export function imageCompat(img: FwImage, t: Target): Compat {
  if (img.header.model !== t.model) return 'wrong_model';
  if (t.hwRev !== null && (t.hwRev < img.header.hwRevMin || t.hwRev > img.header.hwRevMax)) return 'wrong_hw_rev';
  return 'ok';
}

/** Images fit for the board, newest first. */
export function compatibleImages(images: readonly FwImage[], t: Target): FwImage[] {
  return images.filter((i) => imageCompat(i, t) === 'ok').sort((a, b) => cmpVersion(imageVersion(b.header), imageVersion(a.header)));
}

export type CardStatus = 'legacy' | 'offline' | 'bootloader' | 'noImage' | 'hwIncompatible' | 'updateAvailable' | 'upToDate' | 'ahead';

export interface CardInfo extends Target {
  online: boolean;
  legacy: boolean;
  firmwareCapable: boolean;
  bootloader: boolean;
  fw: FwVersion | null;
}

export interface CardAssessment {
  status: CardStatus;
  /** Newest compatible image (undefined when none). */
  best: FwImage | undefined;
}

/**
 * Where a board stands against the library. A board waiting in its bootloader is reported as
 * such whatever the library holds: it needs a recovery upload, not a version comparison.
 */
export function assessCard(card: CardInfo, images: readonly FwImage[]): CardAssessment {
  const best = compatibleImages(images, card)[0];
  if (card.legacy || !card.firmwareCapable) return { status: 'legacy', best: undefined };
  if (!card.online) return { status: 'offline', best };
  if (card.bootloader) return { status: 'bootloader', best };
  if (!best) {
    const sameModel = images.some((i) => i.header.model === card.model);
    return { status: sameModel ? 'hwIncompatible' : 'noImage', best: undefined };
  }
  if (!card.fw) return { status: 'updateAvailable', best };
  const c = cmpVersion(card.fw, imageVersion(best.header));
  return { status: c < 0 ? 'updateAvailable' : c === 0 ? 'upToDate' : 'ahead', best };
}

/** Flashing an older image than what runs needs an explicit extra confirmation. */
export function isDowngrade(installed: Ver | null, image: FwImage): boolean {
  return installed !== null && !isEmptyVersion(installed) && cmpVersion(imageVersion(image.header), installed) < 0;
}

/** Below this the board may brown out mid-flash; the screen warns and asks for a charged supply. */
export const LOW_VOLTAGE_V = 11;

export interface RunRate {
  rateKBs: number;
  etaS: number | null;
}

/** Throughput of the transfer phase and the time left, from acknowledged bytes. */
export function transferRate(sent: number, total: number, elapsedMs: number): RunRate {
  if (elapsedMs <= 0 || sent <= 0) return { rateKBs: 0, etaS: null };
  const bytesPerMs = sent / elapsedMs;
  return { rateKBs: bytesPerMs, etaS: Math.max(0, (total - sent) / bytesPerMs / 1000) };
}
