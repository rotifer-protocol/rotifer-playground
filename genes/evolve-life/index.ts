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

function createGrid(w: number, h: number): number[][] {
  const g: number[][] = [];
  for (let y = 0; y < h; y++) {
    g.push(new Array(w).fill(0));
  }
  return g;
}

function placePattern(grid: number[][], pattern: number[][], cx: number, cy: number): void {
  for (let py = 0; py < pattern.length; py++) {
    for (let px = 0; px < pattern[py].length; px++) {
      const gy = cy + py;
      const gx = cx + px;
      if (gy >= 0 && gy < grid.length && gx >= 0 && gx < grid[0].length) {
        grid[gy][gx] = pattern[py][px];
      }
    }
  }
}

function applyPreset(grid: number[][], preset: string, seed?: number): void {
  const w = grid[0].length;
  const h = grid.length;
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);

  switch (preset) {
    case "glider":
      placePattern(grid, [
        [0, 1, 0],
        [0, 0, 1],
        [1, 1, 1],
      ], cx - 1, cy - 1);
      break;

    case "blinker":
      placePattern(grid, [[1, 1, 1]], cx - 1, cy);
      break;

    case "beacon":
      placePattern(grid, [
        [1, 1, 0, 0],
        [1, 1, 0, 0],
        [0, 0, 1, 1],
        [0, 0, 1, 1],
      ], cx - 2, cy - 2);
      break;

    case "pulsar":
      placePattern(grid, [
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
      placePattern(grid, [
        [0, 1, 1],
        [1, 1, 0],
        [0, 1, 0],
      ], cx - 1, cy - 1);
      break;

    case "random": {
      const rng = mulberry32(seed ?? 42);
      const density = 0.35;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          grid[y][x] = rng() < density ? 1 : 0;
        }
      }
      break;
    }
  }
}

function countAlive(grid: number[][]): number {
  let count = 0;
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[0].length; x++) {
      count += grid[y][x];
    }
  }
  return count;
}

function gridHash(grid: number[][]): string {
  let hash = 0;
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[0].length; x++) {
      hash = ((hash << 5) - hash + grid[y][x]) | 0;
    }
  }
  return hash.toString(36);
}

function step(
  current: number[][],
  next: number[][],
  w: number,
  h: number,
  birth: Set<number>,
  survive: Set<number>
): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dy === 0 && dx === 0) continue;
          const ny = (y + dy + h) % h;
          const nx = (x + dx + w) % w;
          neighbors += current[ny][nx];
        }
      }
      if (current[y][x] === 1) {
        next[y][x] = survive.has(neighbors) ? 1 : 0;
      } else {
        next[y][x] = birth.has(neighbors) ? 1 : 0;
      }
    }
  }
}

function toAscii(grid: number[][], maxW: number, maxH: number): string {
  const h = Math.min(grid.length, maxH);
  const w = Math.min(grid[0].length, maxW);
  const lines: string[] = [];
  for (let y = 0; y < h; y++) {
    let line = "";
    for (let x = 0; x < w; x++) {
      line += grid[y][x] ? "\u2588" : "\u00b7";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function express(input: LifeInput): LifeOutput {
  const w = Math.max(4, Math.min(512, input.width ?? 64));
  const h = Math.max(4, Math.min(512, input.height ?? 64));
  const maxGen = Math.max(1, Math.min(10000, input.generations ?? 100));
  const { birth, survive } = parseRule(input.rule ?? "B3/S23");

  let gridA = createGrid(w, h);
  let gridB = createGrid(w, h);

  if (input.preset) {
    applyPreset(gridA, input.preset, input.seed);
  } else if (input.grid) {
    for (let y = 0; y < Math.min(input.grid.length, h); y++) {
      for (let x = 0; x < Math.min(input.grid[y].length, w); x++) {
        gridA[y][x] = input.grid[y][x] ? 1 : 0;
      }
    }
  } else {
    applyPreset(gridA, "random", input.seed);
  }

  let peak = countAlive(gridA);
  let stabilizedAt = -1;
  let extinction = false;
  let gen = 0;

  let prevHash = gridHash(gridA);
  let prevPrevHash = "";

  for (gen = 0; gen < maxGen; gen++) {
    step(gridA, gridB, w, h, birth, survive);
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
    final_grid: gridA,
    alive_count: finalAlive,
    peak_population: peak,
    stabilized_at: stabilizedAt,
    extinction,
    generations_computed: gen,
    cells_processed: w * h * gen,
    ascii_snapshot: toAscii(gridA, 80, 40),
  };
}
