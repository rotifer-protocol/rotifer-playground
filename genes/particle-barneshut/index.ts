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

interface QuadNode {
  cx: number;
  cy: number;
  mass: number;
  x: number;
  y: number;
  size: number;
  children: (QuadNode | null)[];
  particleIdx: number;
  particleIndices?: number[];
}

const MIN_CELL_SIZE = 1e-10;

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

function createEmptyNode(x: number, y: number, size: number): QuadNode {
  return {
    cx: 0,
    cy: 0,
    mass: 0,
    x,
    y,
    size,
    children: [null, null, null, null],
    particleIdx: -1,
  };
}

function getQuadrant(px: number, py: number, cx: number, cy: number): number {
  if (px < cx) {
    return py < cy ? 0 : 2;
  }
  return py < cy ? 1 : 3;
}

function insertParticle(
  node: QuadNode,
  particles: Particle[],
  idx: number
): void {
  const p = particles[idx];
  const half = node.size / 2;

  if (half < MIN_CELL_SIZE) {
    if (node.particleIdx >= 0) {
      node.particleIndices = [node.particleIdx];
      node.particleIdx = -1;
    }
    if (!node.particleIndices) node.particleIndices = [];
    node.particleIndices.push(idx);
    return;
  }

  if (node.particleIdx >= 0) {
    const existing = particles[node.particleIdx];
    const q = getQuadrant(existing.x, existing.y, node.x, node.y);
    const child = createEmptyNode(
      node.x + (q === 0 || q === 2 ? -half / 2 : half / 2),
      node.y + (q < 2 ? -half / 2 : half / 2),
      half
    );
    insertParticle(child, particles, node.particleIdx);
    node.children[q] = child;
    node.particleIdx = -1;
  }

  const q = getQuadrant(p.x, p.y, node.x, node.y);
  let child = node.children[q];

  if (child === null) {
    child = createEmptyNode(
      node.x + (q === 0 || q === 2 ? -half / 2 : half / 2),
      node.y + (q < 2 ? -half / 2 : half / 2),
      half
    );
    child.particleIdx = idx;
    child.cx = p.x;
    child.cy = p.y;
    child.mass = p.mass;
    node.children[q] = child;
  } else {
    insertParticle(child, particles, idx);
  }
}

function computeCenterOfMass(node: QuadNode, particles: Particle[]): void {
  if (node.particleIdx >= 0) {
    const p = particles[node.particleIdx];
    node.cx = p.x;
    node.cy = p.y;
    node.mass = p.mass;
    return;
  }

  if (node.particleIndices && node.particleIndices.length > 0) {
    let totalMass = 0;
    let sumX = 0;
    let sumY = 0;
    for (const i of node.particleIndices) {
      const p = particles[i];
      totalMass += p.mass;
      sumX += p.x * p.mass;
      sumY += p.y * p.mass;
    }
    if (totalMass > 0) {
      node.cx = sumX / totalMass;
      node.cy = sumY / totalMass;
    }
    node.mass = totalMass;
    return;
  }

  let totalMass = 0;
  let sumX = 0;
  let sumY = 0;

  for (const c of node.children) {
    if (c !== null) {
      computeCenterOfMass(c, particles);
      totalMass += c.mass;
      sumX += c.cx * c.mass;
      sumY += c.cy * c.mass;
    }
  }

  if (totalMass > 0) {
    node.cx = sumX / totalMass;
    node.cy = sumY / totalMass;
  }
  node.mass = totalMass;
}

const THETA = 0.5;

function computeForce(
  node: QuadNode,
  particles: Particle[],
  idx: number,
  G: number,
  softening: number,
  ax: Float64Array,
  ay: Float64Array,
  interactions: { count: number }
): void {
  const p = particles[idx];
  const dx = node.cx - p.x;
  const dy = node.cy - p.y;
  const rSq = dx * dx + dy * dy + softening * softening;
  const r = Math.sqrt(rSq);

  if (node.particleIdx >= 0) {
    if (node.particleIdx === idx) return;
    const factor = (G * node.mass) / Math.pow(rSq, 1.5);
    ax[idx] += factor * dx;
    ay[idx] += factor * dy;
    interactions.count += 1;
    return;
  }

  if (node.particleIndices && node.particleIndices.length > 0) {
    for (const j of node.particleIndices) {
      if (j === idx) continue;
      const pj = particles[j];
      const dxj = pj.x - p.x;
      const dyj = pj.y - p.y;
      const rSqj = dxj * dxj + dyj * dyj + softening * softening;
      const factor = (G * pj.mass) / Math.pow(rSqj, 1.5);
      ax[idx] += factor * dxj;
      ay[idx] += factor * dyj;
      interactions.count += 1;
    }
    return;
  }

  const ratio = node.size / (r + 1e-10);

  if (ratio < THETA) {
    const factor = (G * node.mass) / Math.pow(rSq, 1.5);
    ax[idx] += factor * dx;
    ay[idx] += factor * dy;
    interactions.count += 1;
    return;
  }

  for (const c of node.children) {
    if (c !== null && c.mass > 0) {
      computeForce(c, particles, idx, G, softening, ax, ay, interactions);
    }
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
  const margin = 0.1;

  for (let stepIdx = 0; stepIdx < steps; stepIdx++) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < n; i++) {
      const p = particles[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const size = Math.max(maxX - minX, maxY - minY, 1) / 2 + margin;
    const root = createEmptyNode(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      size
    );

    for (let i = 0; i < n; i++) {
      insertParticle(root, particles, i);
    }
    computeCenterOfMass(root, particles);

    ax.fill(0);
    ay.fill(0);
    const interactions = { count: 0 };

    for (let i = 0; i < n; i++) {
      computeForce(root, particles, i, G, softening, ax, ay, interactions);
    }
    interactionsComputed += interactions.count;

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

    minX = Infinity;
    maxX = -Infinity;
    minY = Infinity;
    maxY = -Infinity;

    for (let i = 0; i < n; i++) {
      const p = particles[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const size2 = Math.max(maxX - minX, maxY - minY, 1) / 2 + margin;
    const root2 = createEmptyNode(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      size2
    );

    for (let i = 0; i < n; i++) {
      insertParticle(root2, particles, i);
    }
    computeCenterOfMass(root2, particles);

    ax.fill(0);
    ay.fill(0);
    const interactions2 = { count: 0 };

    for (let i = 0; i < n; i++) {
      computeForce(root2, particles, i, G, softening, ax, ay, interactions2);
    }
    interactionsComputed += interactions2.count;

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
