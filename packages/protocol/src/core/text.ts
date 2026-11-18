import { NAME_BYTES } from './constants';

// Hand-rolled UTF-8 so the package needs neither DOM nor Node globals (TextEncoder).

export function encodeUtf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0x3f;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

/** Decodes UTF-8, replacing malformed sequences with U+FFFD. */
export function decodeUtf8(b: Uint8Array, start = 0, end = b.length): string {
  let s = '';
  let i = start;
  while (i < end) {
    const c = b[i] ?? 0;
    let cp = 0xfffd;
    let n = 1;
    if (c < 0x80) cp = c;
    else if (c >= 0xc2 && c < 0xe0) n = 2;
    else if (c >= 0xe0 && c < 0xf0) n = 3;
    else if (c >= 0xf0 && c < 0xf5) n = 4;
    if (n > 1) {
      if (i + n > end) {
        cp = 0xfffd;
        n = end - i;
      } else {
        let v = c & (0xff >> (n + 1));
        let ok = true;
        for (let k = 1; k < n; k++) {
          const cc = b[i + k] ?? 0;
          if ((cc & 0xc0) !== 0x80) {
            ok = false;
            n = k;
            break;
          }
          v = (v << 6) | (cc & 0x3f);
        }
        cp = ok ? v : 0xfffd;
      }
    }
    s += String.fromCodePoint(cp);
    i += n;
  }
  return s;
}

/**
 * Board name as stored on INFO pages 4..6: UTF-8, zero padded to 21 bytes.
 * Truncates on a character boundary so the stored bytes always decode cleanly.
 */
export function encodeName(name: string): Uint8Array {
  const out = new Uint8Array(NAME_BYTES);
  let len = 0;
  for (const ch of name) {
    const enc = encodeUtf8(ch);
    if (len + enc.length > NAME_BYTES) break;
    out.set(enc, len);
    len += enc.length;
  }
  return out;
}

export function decodeName(bytes: Uint8Array): string {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return decodeUtf8(bytes, 0, end);
}

/** Printable ASCII only; anything else becomes '?'. Zero padded to `len`. */
export function encodeAscii(s: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len && i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c >= 0x20 && c < 0x7f ? c : 0x3f;
  }
  return out;
}

export function decodeAscii(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) {
    const c = b[i] ?? 0;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
