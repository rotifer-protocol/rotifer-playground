interface LifeInput {
  width?: number;
  height?: number;
  generations?: number;
  preset?: "glider" | "pulsar" | "blinker" | "beacon" | "r-pentomino" | "random";
  grid?: number[][];
  rule?: string;
  seed?: number;
}

interface LifeOutput {
  final_grid: number[][];
  alive_count: number;
  peak_population: number;
  stabilized_at: number;
  extinction: boolean;
  generations_computed: number;
  cells_processed: number;
  ascii_snapshot?: string;
}

function parseRule(rule: string): { birth: number[]; survive: number[] } {
  const birth: number[] = [];
  const survive: number[] = [];
  const match = rule.match(/B([0-8]*)\/S([0-8]*)/);
  if (!match) return { birth: [3], survive: [2, 3] };
  for (const ch of match[1]) birth.push(parseInt(ch));
  for (const ch of match[2]) survive.push(parseInt(ch));
  return { birth, survive };
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORD_BITS = 32;

function wordsPerRow(w: number): number {
  return ((w + WORD_BITS - 1) / WORD_BITS) | 0;
}

function createBitGrid(w: number, h: number): Int32Array {
  return new Int32Array(h * wordsPerRow(w));
}

function getBit(grid: Int32Array, wpr: number, x: number, y: number): number {
  const wordIdx = y * wpr + ((x / WORD_BITS) | 0);
  const bitIdx = x % WORD_BITS;
  return (grid[wordIdx] >>> bitIdx) & 1;
}

function setBit(grid: Int32Array, wpr: number, x: number, y: number): void {
  const wordIdx = y * wpr + ((x / WORD_BITS) | 0);
  const bitIdx = x % WORD_BITS;
  grid[wordIdx] |= 1 << bitIdx;
}

function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function countAlive(grid: Int32Array): number {
  let count = 0;
  for (let i = 0; i < grid.length; i++) {
    count += popcount32(grid[i]);
  }
  return count;
}

function gridHash(grid: Int32Array): number {
  let h = 0;
  for (let i = 0; i < grid.length; i++) {
    h = ((h << 5) - h + grid[i]) | 0;
  }
  return h;
}

function placePattern(grid: Int32Array, wpr: number, w: number, h: number, pattern: number[][], ox: number, oy: number): void {
  for (let py = 0; py < pattern.length; py++) {
    for (let px = 0; px < pattern[py].length; px++) {
      if (pattern[py][px]) {
        const gx = ox + px;
        const gy = oy + py;
        if (gx >= 0 && gx < w && gy >= 0 && gy < h) setBit(grid, wpr, gx, gy);
      }
    }
  }
}

function applyPreset(grid: Int32Array, wpr: number, w: number, h: number, preset: string, seed?: number): void {
  const cx = (w / 2) | 0;
  const cy = (h / 2) | 0;

  switch (preset) {
    case "glider":
      placePattern(grid, wpr, w, h, [[0,1,0],[0,0,1],[1,1,1]], cx - 1, cy - 1);
      break;
    case "blinker":
      placePattern(grid, wpr, w, h, [[1,1,1]], cx - 1, cy);
      break;
    case "beacon":
      placePattern(grid, wpr, w, h, [[1,1,0,0],[1,1,0,0],[0,0,1,1],[0,0,1,1]], cx - 2, cy - 2);
      break;
    case "pulsar":
      placePattern(grid, wpr, w, h, [
        [0,0,1,1,1,0,0,0,1,1,1,0,0],
        [0,0,0,0,0,0,0,0,0,0,0,0,0],
        [1,0,0,0,0,1,0,1,0,0,0,0,1],
        [1,0,0,0,0,1,0,1,0,0,0,0,1],
        [1,0,0,0,0,1,0,1,0,0,0,0,1],
        [0,0,1,1,1,0,0,0,1,1,1,0,0],
        [0,0,0,0,0,0,0,0,0,0,0,0,0],
        [0,0,1,1,1,0,0,0,1,1,1,0,0],
        [1,0,0,0,0,1,0,1,0,0,0,0,1],
        [1,0,0,0,0,1,0,1,0,0,0,0,1],
        [1,0,0,0,0,1,0,1,0,0,0,0,1],
        [0,0,0,0,0,0,0,0,0,0,0,0,0],
        [0,0,1,1,1,0,0,0,1,1,1,0,0],
      ], cx - 6, cy - 6);
      break;
    case "r-pentomino":
      placePattern(grid, wpr, w, h, [[0,1,1],[1,1,0],[0,1,0]], cx - 1, cy - 1);
      break;
    case "random": {
      const rng = mulberry32(seed ?? 42);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (rng() < 0.35) setBit(grid, wpr, x, y);
        }
      }
      break;
    }
  }
}

function step(
  current: Int32Array,
  next: Int32Array,
  w: number,
  h: number,
  wpr: number,
  birthLut: Uint8Array,
  surviveLut: Uint8Array
): void {
  next.fill(0);
  for (let y = 0; y < h; y++) {
    const yn = (y - 1 + h) % h;
    const ys = (y + 1) % h;
    for (let x = 0; x < w; x++) {
      let neighbors = 0;
      const xw = (x - 1 + w) % w;
      const xe = (x + 1) % w;
      neighbors += getBit(current, wpr, xw, yn);
      neighbors += getBit(current, wpr, x,  yn);
      neighbors += getBit(current, wpr, xe, yn);
      neighbors += getBit(current, wpr, xw, y);
      neighbors += getBit(current, wpr, xe, y);
      neighbors += getBit(current, wpr, xw, ys);
      neighbors += getBit(current, wpr, x,  ys);
      neighbors += getBit(current, wpr, xe, ys);

      const isAlive = getBit(current, wpr, x, y);
      if (isAlive ? surviveLut[neighbors] : birthLut[neighbors]) {
        setBit(next, wpr, x, y);
      }
    }
  }
}

function bitGridToArray(grid: Int32Array, wpr: number, w: number, h: number): number[][] {
  const result: number[][] = [];
  for (let y = 0; y < h; y++) {
    const row = new Array(w);
    for (let x = 0; x < w; x++) {
      row[x] = getBit(grid, wpr, x, y);
    }
    result.push(row);
  }
  return result;
}

function toAscii(grid: Int32Array, wpr: number, w: number, h: number): string {
  const maxW = Math.min(w, 80);
  const maxH = Math.min(h, 40);
  const lines: string[] = [];
  for (let y = 0; y < maxH; y++) {
    let line = "";
    for (let x = 0; x < maxW; x++) {
      line += getBit(grid, wpr, x, y) ? "\u2588" : "\u00b7";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export async function express(input: LifeInput): Promise<LifeOutput> {
  const w = Math.max(4, Math.min(512, input.width ?? 64));
  const h = Math.max(4, Math.min(512, input.height ?? 64));
  const maxGen = Math.max(1, Math.min(10000, input.generations ?? 100));
  const { birth, survive } = parseRule(input.rule ?? "B3/S23");

  const birthLut = new Uint8Array(9);
  const surviveLut = new Uint8Array(9);
  for (const b of birth) birthLut[b] = 1;
  for (const s of survive) surviveLut[s] = 1;

  const wpr = wordsPerRow(w);
  let gridA = createBitGrid(w, h);
  let gridB = createBitGrid(w, h);

  if (input.preset) {
    applyPreset(gridA, wpr, w, h, input.preset, input.seed);
  } else if (input.grid) {
    for (let y = 0; y < Math.min(input.grid.length, h); y++) {
      for (let x = 0; x < Math.min(input.grid[y].length, w); x++) {
        if (input.grid[y][x]) setBit(gridA, wpr, x, y);
      }
    }
  } else {
    applyPreset(gridA, wpr, w, h, "random", input.seed);
  }

  let peak = countAlive(gridA);
  let stabilizedAt = -1;
  let extinction = false;
  let gen = 0;
  let prevHash = gridHash(gridA);
  let prevPrevHash = 0;

  for (gen = 0; gen < maxGen; gen++) {
    step(gridA, gridB, w, h, wpr, birthLut, surviveLut);
    [gridA, gridB] = [gridB, gridA];

    const alive = countAlive(gridA);
    if (alive > peak) peak = alive;

    if (alive === 0) {
      extinction = true;
      gen++;
      break;
    }

    const currentHash = gridHash(gridA);
    if (currentHash === prevHash || currentHash === prevPrevHash) {
      stabilizedAt = gen + 1;
      gen++;
      break;
    }
    prevPrevHash = prevHash;
    prevHash = currentHash;
  }

  const finalAlive = countAlive(gridA);

  return {
    final_grid: bitGridToArray(gridA, wpr, w, h),
    alive_count: finalAlive,
    peak_population: peak,
    stabilized_at: stabilizedAt,
    extinction,
    generations_computed: gen,
    cells_processed: w * h * gen,
    ascii_snapshot: toAscii(gridA, wpr, w, h),
  };
}
