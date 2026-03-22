interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
}

interface ParticleInput {
  particles?: Particle[];
  preset?: "solar" | "binary" | "cluster" | "collision";
  count?: number;
  steps?: number;
  dt?: number;
  G?: number;
  softening?: number;
  seed?: number;
}

interface ParticleOutput {
  particles: Particle[];
  steps_computed: number;
  total_energy: number;
  interactions_computed: number;
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

function generatePreset(
  preset: "solar" | "binary" | "cluster" | "collision",
  count: number,
  seed: number
): Particle[] {
  const rng = mulberry32(seed);
  const G = 1.0;

  switch (preset) {
    case "solar": {
      const particles: Particle[] = [];
      const M_central = 100;
      particles.push({ x: 0, y: 0, vx: 0, vy: 0, mass: M_central });

      const nOrbiters = Math.min(count - 1, 63);
      for (let i = 0; i < nOrbiters; i++) {
        const r = 2 + rng() * 8;
        const theta = rng() * 2 * Math.PI;
        const x = r * Math.cos(theta);
        const y = r * Math.sin(theta);
        const v = Math.sqrt((G * M_central) / r);
        const vx = -v * Math.sin(theta);
        const vy = v * Math.cos(theta);
        const mass = 0.1 + rng() * 0.9;
        particles.push({ x, y, vx, vy, mass });
      }
      return particles;
    }

    case "binary": {
      const particles: Particle[] = [];
      const m1 = 50;
      const m2 = 50;
      const d = 4;
      const r1 = (d * m2) / (m1 + m2);
      const r2 = (d * m1) / (m1 + m2);
      const omega = Math.sqrt((G * (m1 + m2)) / (d * d * d));
      const v1 = omega * r1;
      const v2 = omega * r2;

      particles.push({ x: -r1, y: 0, vx: 0, vy: -v1, mass: m1 });
      particles.push({ x: r2, y: 0, vx: 0, vy: v2, mass: m2 });

      const nDebris = Math.min(count - 2, 62);
      for (let i = 0; i < nDebris; i++) {
        const r = 6 + rng() * 4;
        const theta = rng() * 2 * Math.PI;
        const x = r * Math.cos(theta);
        const y = r * Math.sin(theta);
        const v = Math.sqrt((G * (m1 + m2)) / r) * (0.8 + rng() * 0.4);
        const vx = -v * Math.sin(theta);
        const vy = v * Math.cos(theta);
        const mass = 0.1 + rng() * 0.5;
        particles.push({ x, y, vx, vy, mass });
      }
      return particles;
    }

    case "cluster": {
      const particles: Particle[] = [];
      const radius = 5;
      for (let i = 0; i < count; i++) {
        const r = radius * Math.sqrt(rng());
        const theta = rng() * 2 * Math.PI;
        const x = r * Math.cos(theta);
        const y = r * Math.sin(theta);
        const vMax = 0.3;
        const vx = (rng() - 0.5) * 2 * vMax;
        const vy = (rng() - 0.5) * 2 * vMax;
        const mass = 0.5 + rng() * 1.5;
        particles.push({ x, y, vx, vy, mass });
      }
      return particles;
    }

    case "collision": {
      const particles: Particle[] = [];
      const half = Math.floor(count / 2);
      const sep = 10;
      const vApproach = 1.5;

      for (let i = 0; i < half; i++) {
        const x = -sep + (rng() - 0.5) * 4;
        const y = (rng() - 0.5) * 4;
        const vx = vApproach + (rng() - 0.5) * 0.4;
        const vy = (rng() - 0.5) * 0.4;
        const mass = 0.5 + rng() * 1.5;
        particles.push({ x, y, vx, vy, mass });
      }
      for (let i = 0; i < count - half; i++) {
        const x = sep + (rng() - 0.5) * 4;
        const y = (rng() - 0.5) * 4;
        const vx = -vApproach + (rng() - 0.5) * 0.4;
        const vy = (rng() - 0.5) * 0.4;
        const mass = 0.5 + rng() * 1.5;
        particles.push({ x, y, vx, vy, mass });
      }
      return particles;
    }

    default:
      return generatePreset("cluster", count, seed);
  }
}

function computeTotalEnergy(
  particles: Particle[],
  G: number,
  softening: number
): number {
  let kinetic = 0;
  let potential = 0;
  const n = particles.length;

  for (let i = 0; i < n; i++) {
    const p = particles[i];
    kinetic += 0.5 * p.mass * (p.vx * p.vx + p.vy * p.vy);
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const pi = particles[i];
      const pj = particles[j];
      const dx = pj.x - pi.x;
      const dy = pj.y - pi.y;
      const rSq = dx * dx + dy * dy + softening * softening;
      const r = Math.sqrt(rSq);
      potential -= (G * pi.mass * pj.mass) / r;
    }
  }

  return kinetic + potential;
}

function buildGrid(
  particles: Particle[],
  cellSize: number
): Map<string, number[]> {
  const grid = new Map<string, number[]>();
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const cx = Math.floor(p.x / cellSize);
    const cy = Math.floor(p.y / cellSize);
    const key = `${cx},${cy}`;
    let cell = grid.get(key);
    if (!cell) {
      cell = [];
      grid.set(key, cell);
    }
    cell.push(i);
  }
  return grid;
}

function computeForcesSpatial(
  particles: Particle[],
  grid: Map<string, number[]>,
  cellSize: number,
  ax: Float64Array,
  ay: Float64Array,
  G: number,
  softening: number
): number {
  const n = particles.length;
  let interactions = 0;

  for (let i = 0; i < n; i++) {
    const pi = particles[i];
    const cx = Math.floor(pi.x / cellSize);
    const cy = Math.floor(pi.y / cellSize);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${cx + dx},${cy + dy}`;
        const cell = grid.get(key);
        if (!cell) continue;

        for (const j of cell) {
          if (j === i) continue;
          const pj = particles[j];
          const ddx = pj.x - pi.x;
          const ddy = pj.y - pi.y;
          const rSq = ddx * ddx + ddy * ddy + softening * softening;
          const rSoft = Math.pow(rSq, 1.5);
          const factor = G / rSoft;

          ax[i] += factor * pj.mass * ddx;
          ay[i] += factor * pj.mass * ddy;
          interactions++;
        }
      }
    }
  }

  return interactions;
}

export async function express(input: ParticleInput): Promise<ParticleOutput> {
  const count = Math.max(2, Math.min(2048, input.count ?? 64));
  const steps = Math.max(1, Math.min(10000, input.steps ?? 100));
  const dt = input.dt ?? 0.01;
  const G = input.G ?? 1.0;
  const softening = input.softening ?? 0.01;
  const seed = input.seed ?? 42;

  let particles: Particle[];

  if (input.particles && input.particles.length > 0) {
    particles = input.particles.map((p) => ({
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      mass: p.mass,
    }));
  } else {
    const preset = input.preset ?? "cluster";
    particles = generatePreset(preset, count, seed);
  }

  const n = particles.length;
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  let interactionsComputed = 0;

  for (let stepIdx = 0; stepIdx < steps; stepIdx++) {
    let minX = particles[0].x;
    let maxX = particles[0].x;
    let minY = particles[0].y;
    let maxY = particles[0].y;

    for (let i = 1; i < n; i++) {
      const p = particles[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const w = Math.max(maxX - minX, softening * 4);
    const h = Math.max(maxY - minY, softening * 4);
    const area = w * h;
    const cellSize = Math.max(softening * 2, Math.sqrt(area / n) * 2);

    const grid = buildGrid(particles, cellSize);

    ax.fill(0);
    ay.fill(0);
    interactionsComputed += computeForcesSpatial(
      particles,
      grid,
      cellSize,
      ax,
      ay,
      G,
      softening
    );

    for (let i = 0; i < n; i++) {
      const p = particles[i];
      p.vx += 0.5 * dt * ax[i];
      p.vy += 0.5 * dt * ay[i];
    }

    for (let i = 0; i < n; i++) {
      const p = particles[i];
      p.x += dt * p.vx;
      p.y += dt * p.vy;
    }

    minX = particles[0].x;
    maxX = particles[0].x;
    minY = particles[0].y;
    maxY = particles[0].y;
    for (let i = 1; i < n; i++) {
      const p = particles[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const w2 = Math.max(maxX - minX, softening * 4);
    const h2 = Math.max(maxY - minY, softening * 4);
    const area2 = w2 * h2;
    const cellSize2 = Math.max(softening * 2, Math.sqrt(area2 / n) * 2);

    const grid2 = buildGrid(particles, cellSize2);

    ax.fill(0);
    ay.fill(0);
    interactionsComputed += computeForcesSpatial(
      particles,
      grid2,
      cellSize2,
      ax,
      ay,
      G,
      softening
    );

    for (let i = 0; i < n; i++) {
      const p = particles[i];
      p.vx += 0.5 * dt * ax[i];
      p.vy += 0.5 * dt * ay[i];
    }
  }

  const totalEnergy = computeTotalEnergy(particles, G, softening);

  return {
    particles,
    steps_computed: steps,
    total_energy: totalEnergy,
    interactions_computed: interactionsComputed,
  };
}
