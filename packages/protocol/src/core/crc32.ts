// CRC-32/IEEE 802.3 (zlib, reflected, poly 0xEDB88320, init/xorout 0xFFFFFFFF).

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Continues a running CRC; pass the previous result as `crc` (start with 0). */
export function crc32Update(crc: number, data: Uint8Array, start = 0, end = data.length): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = start; i < end; i++) c = (TABLE[(c ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  return crc32Update(0, data, start, end);
}
