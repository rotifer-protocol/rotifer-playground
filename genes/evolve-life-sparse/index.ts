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

function parseRule(rule: string): { birth: Set<number>; survive: Set<number> } {
  const birth = new Set<number>();
  const survive = new Set<number>();
  const match = rule.match(/B([0-8]*)\/S([0-8]*)/);
  if (!match) return { birth: new Set([3]), survive: new Set([2, 3]) };
  for (const ch of match[1]) birth.add(parseInt(ch));
  for (const ch of match[2]) survive.add(parseInt(ch));
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

function cellKey(x: number, y: number): number {
  return y * 65536 + x;
}

function keyToXY(key: number): [number, number] {
  return [key % 65536, (key / 65536) | 0];
}

function presetCells(preset: string, w: number, h: number, seed?: number): Set<number> {
  const cells = new Set<number>();
  const cx = (w / 2) | 0;
  const cy = (h / 2) | 0;

  const place = (pattern: number[][], ox: number, oy: number) => {
    for (let py = 0; py < pattern.length; py++) {
      for (let px = 0; px < pattern[py].length; px++) {
        if (pattern[py][px]) {
          const gx = ox + px;
          const gy = oy + py;
          if (gx >= 0 && gx < w && gy >= 0 && gy < h) cells.add(cellKey(gx, gy));
        }
      }
    }
  };

  switch (preset) {
    case "glider":
      place([[0,1,0],[0,0,1],[1,1,1]], cx - 1, cy - 1);
      break;
    case "blinker":
      place([[1,1,1]], cx - 1, cy);
      break;
    case "beacon":
      place([[1,1,0,0],[1,1,0,0],[0,0,1,1],[0,0,1,1]], cx - 2, cy - 2);
      break;
    case "pulsar":
      place([
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
      place([[0,1,1],[1,1,0],[0,1,0]], cx - 1, cy - 1);
      break;
    case "random": {
      const rng = mulberry32(seed ?? 42);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (rng() < 0.35) cells.add(cellKey(x, y));
        }
      }
      break;
    }
  }
  return cells;
}

function sparseStep(
  alive: Set<number>,
  w: number,
  h: number,
  birth: Set<number>,
  survive: Set<number>
): Set<number> {
  const neighborCount = new Map<number, number>();

  for (const key of alive) {
    const [x, y] = keyToXY(key);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dy === 0 && dx === 0) continue;
        const nx = (x + dx + w) % w;
        const ny = (y + dy + h) % h;
        const nk = cellKey(nx, ny);
        neighborCount.set(nk, (neighborCount.get(nk) || 0) + 1);
      }
    }
  }

  const next = new Set<number>();
  for (const [key, count] of neighborCount) {
    if (alive.has(key)) {
      if (survive.has(count)) next.add(key);
    } else {
      if (birth.has(count)) next.add(key);
    }
  }
  return next;
}

function sparseHash(alive: Set<number>): number {
  let h = 0;
  for (const key of alive) {
    h = ((h << 5) - h + key) | 0;
  }
  return h;
}

function toGrid(alive: Set<number>, w: number, h: number): number[][] {
  const grid: number[][] = [];
  for (let y = 0; y < h; y++) {
    const row = new Array(w).fill(0);
    for (let x = 0; x < w; x++) {
      if (alive.has(cellKey(x, y))) row[x] = 1;
    }
    grid.push(row);
  }
  return grid;
}

function toAscii(alive: Set<number>, w: number, h: number): string {
  const maxW = Math.min(w, 80);
  const maxH = Math.min(h, 40);
  const lines: string[] = [];
  for (let y = 0; y < maxH; y++) {
    let line = "";
    for (let x = 0; x < maxW; x++) {
      line += alive.has(cellKey(x, y)) ? "\u2588" : "\u00b7";
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

  let alive: Set<number>;

  if (input.preset) {
    alive = presetCells(input.preset, w, h, input.seed);
  } else if (input.grid) {
    alive = new Set<number>();
    for (let y = 0; y < Math.min(input.grid.length, h); y++) {
      for (let x = 0; x < Math.min(input.grid[y].length, w); x++) {
        if (input.grid[y][x]) alive.add(cellKey(x, y));
      }
    }
  } else {
    alive = presetCells("random", w, h, input.seed);
  }

  let peak = alive.size;
  let stabilizedAt = -1;
  let extinction = false;
  let gen = 0;
  let prevHash = sparseHash(alive);
  let prevPrevHash = 0;

  for (gen = 0; gen < maxGen; gen++) {
    alive = sparseStep(alive, w, h, birth, survive);

    if (alive.size > peak) peak = alive.size;

    if (alive.size === 0) {
      extinction = true;
      gen++;
      break;
    }

    const currentHash = sparseHash(alive);
    if (currentHash === prevHash || currentHash === prevPrevHash) {
      stabilizedAt = gen + 1;
      gen++;
      break;
    }
    prevPrevHash = prevHash;
    prevHash = currentHash;
  }

  return {
    final_grid: toGrid(alive, w, h),
    alive_count: alive.size,
    peak_population: peak,
    stabilized_at: stabilizedAt,
    extinction,
    generations_computed: gen,
    cells_processed: w * h * gen,
    ascii_snapshot: toAscii(alive, w, h),
  };
}
