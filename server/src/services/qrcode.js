// Dependency-free QR Code encoder (ISO/IEC 18004) + PNG writer.
//
// Why hand-rolled: the panel runs from a raw GitHub tarball with a fixed
// dependency list, and the live fleet must not need an extra npm install to
// gain a feature. This module encodes byte-mode QR symbols (versions 1–10,
// ECC level M preferred with L fallback — a subscription URL is well under the
// ~270-byte M capacity of v10) and renders them to a grayscale PNG using only
// Node's built-in zlib. It is exercised three ways before shipping: a published
// Reed–Solomon test vector, an independent round-trip decoder in the test
// suite, and codeword-for-codeword equality against qrcode.react in the UI
// harness (codewords are mask-independent, so equality proves the encoding).
//
// Layout follows the standard: finder patterns + separators, timing patterns,
// alignment patterns, dark module, format info (BCH 15,5, XOR 0x5412), version
// info for v≥7 (BCH 18,6), zigzag data placement skipping column 6, and the
// eight standard masks scored by the four penalty rules.

'use strict';

// ---- GF(256), primitive polynomial 0x11d ---------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// Generator polynomial of degree n, highest-degree coefficient first, with
// the leading 1 dropped (length n). g(x) = Π (x + α^i), i = 0..n-1.
function rsGenPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly.slice(1); // drop leading 1
}

// Systematic Reed–Solomon remainder: n ECC codewords for the data block.
function rsRemainder(data, n) {
  const gen = rsGenPoly(n);
  const rem = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < n; i += 1) rem[i] ^= gfMul(gen[i], factor);
  }
  return rem;
}

// ---- capacity tables (byte mode) ------------------------------------------
// Per version and ECC level: ecc codewords per block, then [count, dataLen]
// groups. Source: ISO 18004 tables 13–22 (same numbers every QR library uses).
const BLOCKS = {
  1: { L: { ecc: 7, groups: [[1, 19]] }, M: { ecc: 10, groups: [[1, 16]] } },
  2: { L: { ecc: 10, groups: [[1, 34]] }, M: { ecc: 16, groups: [[1, 28]] } },
  3: { L: { ecc: 15, groups: [[1, 55]] }, M: { ecc: 26, groups: [[1, 44]] } },
  4: { L: { ecc: 20, groups: [[1, 80]] }, M: { ecc: 18, groups: [[2, 32]] } },
  5: { L: { ecc: 26, groups: [[1, 108]] }, M: { ecc: 24, groups: [[2, 43]] } },
  6: { L: { ecc: 18, groups: [[2, 68]] }, M: { ecc: 16, groups: [[4, 27]] } },
  7: { L: { ecc: 20, groups: [[2, 78]] }, M: { ecc: 18, groups: [[4, 31]] } },
  8: { L: { ecc: 24, groups: [[2, 97]] }, M: { ecc: 22, groups: [[2, 38], [2, 39]] } },
  9: { L: { ecc: 30, groups: [[2, 116]] }, M: { ecc: 22, groups: [[3, 36], [2, 37]] } },
  10: { L: { ecc: 18, groups: [[2, 68], [2, 69]] }, M: { ecc: 26, groups: [[4, 43], [1, 44]] } },
};

const ALIGN = {
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// BCH(18,6) version information, generator 0x1F25, precomputed per version.
const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

const ECL_BITS = { L: 1, M: 0 }; // format-info bit pattern per level

function dataCodewords(version, ecl) {
  let total = 0;
  for (const [count, len] of BLOCKS[version][ecl].groups) total += count * len;
  return total;
}

function pickVersion(byteLen) {
  // Prefer M at the smallest version that fits; fall back to L only if no M
  // version 1–10 fits. Char-count bits: 8 for v1–9, 16 for v10 (byte mode).
  for (const ecl of ['M', 'L']) {
    for (let v = 1; v <= 10; v += 1) {
      const ccBits = v <= 9 ? 8 : 16;
      if (4 + ccBits + 8 * byteLen <= dataCodewords(v, ecl) * 8) return { version: v, ecl };
    }
  }
  return null;
}

// ---- bit buffer ------------------------------------------------------------
function makeBits(bytes, version, ecl) {
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version, ecl) * 8;
  push(0, Math.min(4, capacity - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const pads = [0xec, 0x11];
  let p = 0;
  while (bits.length < capacity) {
    push(pads[p % 2], 8);
    p += 1;
  }
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

// Split into blocks, compute ECC per block, interleave data then ECC.
function interleave(codewords, version, ecl) {
  const { ecc, groups } = BLOCKS[version][ecl];
  const dataBlocks = [];
  const eccBlocks = [];
  let offset = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i += 1) {
      const block = codewords.slice(offset, offset + len);
      offset += len;
      dataBlocks.push(block);
      eccBlocks.push(rsRemainder(block, ecc));
    }
  }
  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecc; i += 1) {
    for (const block of eccBlocks) out.push(block[i]);
  }
  return out;
}

// ---- matrix drawing ---------------------------------------------------------
// grid[y][x] = 0/1 module value; fn[y][x] = true where a function pattern lives.
function drawFunctionPatterns(grid, fn, version) {
  const size = grid.length;
  const set = (x, y, dark) => {
    grid[y][x] = dark ? 1 : 0;
    fn[y][x] = true;
  };
  // Finder patterns with their separators, drawn as 9×9 around each corner.
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
  // Alignment patterns (skip the three finder corners).
  const centers = ALIGN[version] || [];
  for (const cy of centers) {
    for (const cx of centers) {
      const corner = (cx === 6 && cy === 6)
        || (cx === 6 && cy === size - 7)
        || (cx === size - 7 && cy === 6);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // Reserve the format-info areas (values written later) + dark module.
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      set(8, i, false);
      set(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    set(size - 1 - i, 8, false);
    set(8, size - 8 + i, false);
  }
  set(8, size - 8, true); // dark module, always
  // Version info for v≥7: two 3×6 blocks.
  if (version >= 7) {
    const info = VERSION_INFO[version];
    for (let i = 0; i < 18; i += 1) {
      const bit = ((info >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }
}

function formatBits(ecl, mask) {
  const data = (ECL_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(grid, ecl, mask) {
  const size = grid.length;
  const bits = formatBits(ecl, mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  // First copy: around the top-left finder.
  for (let i = 0; i <= 5; i += 1) grid[i][8] = bit(i) ? 1 : 0;
  grid[7][8] = bit(6) ? 1 : 0;
  grid[8][8] = bit(7) ? 1 : 0;
  grid[8][7] = bit(8) ? 1 : 0;
  for (let i = 9; i < 15; i += 1) grid[8][14 - i] = bit(i) ? 1 : 0;
  // Second copy: along the other two edges.
  for (let i = 0; i < 8; i += 1) grid[8][size - 1 - i] = bit(i) ? 1 : 0;
  for (let i = 8; i < 15; i += 1) grid[size - 15 + i][8] = bit(i) ? 1 : 0;
  grid[size - 8][8] = 1; // dark module again
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function placeData(grid, fn, codewords) {
  const size = grid.length;
  let i = 0; // bit index across the codeword stream
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert += 1) {
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        if (fn[y][x]) continue;
        let dark = false;
        if (i < total) {
          dark = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i += 1;
        }
        grid[y][x] = dark ? 1 : 0; // remainder bits stay light
      }
    }
  }
}

function applyMask(grid, fn, mask) {
  const size = grid.length;
  const test = MASKS[mask];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!fn[y][x] && test(x, y)) grid[y][x] ^= 1;
    }
  }
}

const FINDER_LIKE_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const FINDER_LIKE_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

function penalty(grid) {
  const size = grid.length;
  let score = 0;
  // Rule 1: runs of five or more same-colored modules, rows and columns.
  for (let y = 0; y < size; y += 1) {
    let runColor = grid[y][0];
    let runLen = 1;
    for (let x = 1; x < size; x += 1) {
      if (grid[y][x] === runColor) runLen += 1;
      else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = grid[y][x];
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (let x = 0; x < size; x += 1) {
    let runColor = grid[0][x];
    let runLen = 1;
    for (let y = 1; y < size; y += 1) {
      if (grid[y][x] === runColor) runLen += 1;
      else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = grid[y][x];
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  // Rule 2: 2×2 blocks of one color.
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = grid[y][x];
      if (c === grid[y][x + 1] && c === grid[y + 1][x] && c === grid[y + 1][x + 1]) score += 3;
    }
  }
  // Rule 3: finder-like 1:1:3:1:1 with four light modules on either side.
  const matches = (get, start, pattern) => {
    for (let k = 0; k < 11; k += 1) if (get(start + k) !== pattern[k]) return false;
    return true;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x <= size - 11; x += 1) {
      if (matches((k) => grid[y][k], x, FINDER_LIKE_A)) score += 40;
      if (matches((k) => grid[y][k], x, FINDER_LIKE_B)) score += 40;
    }
  }
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y <= size - 11; y += 1) {
      if (matches((k) => grid[k][x], y, FINDER_LIKE_A)) score += 40;
      if (matches((k) => grid[k][x], y, FINDER_LIKE_B)) score += 40;
    }
  }
  // Rule 4: dark-module proportion, in steps of 5% away from 50%.
  let dark = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) dark += grid[y][x];
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += k * 10;
  return score;
}

/**
 * Encode text into a QR symbol. Returns the module matrix (array of rows of
 * 0/1), its size, and the chosen version / ECC level / mask. Throws a plain
 * Error for input too long for versions 1–10; callers map it to their own
 * error type.
 */
function qrMatrix(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const picked = pickVersion(bytes.length);
  if (!picked) {
    const err = new Error('text_too_long_for_qr');
    err.code = 'qr_too_long';
    throw err;
  }
  const { version, ecl } = picked;
  const size = version * 4 + 17;
  const codewords = interleave(makeBits(bytes, version, ecl), version, ecl);
  const grid = Array.from({ length: size }, () => new Array(size).fill(0));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  drawFunctionPatterns(grid, fn, version);
  placeData(grid, fn, codewords);
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(grid, fn, mask);
    drawFormat(grid, ecl, mask);
    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    applyMask(grid, fn, mask); // XOR again restores the unmasked data
  }
  applyMask(grid, fn, bestMask);
  drawFormat(grid, ecl, bestMask);
  return { matrix: grid, size, version, ecl, mask: bestMask, codewords };
}

// ---- PNG writer (grayscale, built-in zlib only) ------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Render text as a QR PNG. `scale` is pixels per module, `margin` the quiet
 * zone in modules (spec minimum 4). Returns {buffer, width, ...symbol info}.
 */
function qrPng(text, { scale = 8, margin = 4 } = {}) {
  const symbol = qrMatrix(text);
  const s = Math.max(1, Math.min(40, Math.round(scale)));
  const m = Math.max(0, Math.min(16, Math.round(margin)));
  const width = (symbol.size + m * 2) * s;
  const zlib = require('zlib');
  const raw = Buffer.alloc(width * (width + 1)); // filter byte + row pixels
  let pos = 0;
  for (let py = 0; py < width; py += 1) {
    raw[pos] = 0; // filter type 0 (None)
    pos += 1;
    const my = Math.floor(py / s) - m;
    for (let px = 0; px < width; px += 1) {
      const mx = Math.floor(px / s) - m;
      const inside = my >= 0 && my < symbol.size && mx >= 0 && mx < symbol.size;
      raw[pos] = inside && symbol.matrix[my][mx] === 1 ? 0 : 255;
      pos += 1;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(width, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0 = grayscale
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return {
    buffer: png,
    width,
    size: symbol.size,
    version: symbol.version,
    ecl: symbol.ecl,
    mask: symbol.mask,
  };
}

module.exports = { qrMatrix, qrPng, rsRemainder, rsGenPoly, BLOCKS, formatBits };