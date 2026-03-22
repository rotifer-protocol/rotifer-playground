# particle-barneshut

Barnes-Hut quadtree N-body gravitational simulation — a pure-computation Native Gene for the Rotifer Protocol.

## Algorithm

Builds a quadtree each step to hierarchically group distant particles. When computing the force on particle i:

1. If a tree node is a leaf containing a different particle, compute direct force
2. If an internal node satisfies `(size / distance) < θ`, approximate all particles in that node as a single body at its center of mass
3. Otherwise, recurse into the four children (NW, NE, SW, SE)

With θ = 0.5 (the default opening angle), this achieves O(n log n) force evaluations per step while maintaining good accuracy — typically within 1-2% of the exact brute-force solution.

Integration uses the symplectic leapfrog (kick-drift-kick) scheme.

## Usage

```bash
# Solar system preset (64 particles)
rotifer run particle-barneshut --input '{"preset": "solar"}'

# Large cluster (512 particles, 200 steps)
rotifer run particle-barneshut --input '{"preset": "cluster", "count": 512, "steps": 200}'

# Binary star system
rotifer run particle-barneshut --input '{"preset": "binary", "count": 100}'
```

## Presets

| Preset | Description |
|--------|-------------|
| `solar` | Central massive body + orbiting lighter bodies with circular velocities |
| `binary` | Two equal-mass stars in mutual orbit + debris ring |
| `cluster` | Random particles in a disk with small random velocities |
| `collision` | Two groups of particles approaching head-on |

## Output

- `particles` — final positions and velocities of all particles
- `steps_computed` — number of simulation steps executed
- `total_energy` — total system energy (kinetic + potential) for conservation validation
- `interactions_computed` — total tree-node force evaluations (fewer than brute-force)

## Fitness Characteristics

| Metric | Expected |
|--------|----------|
| Success Rate | 1.0 (deterministic, no failure mode) |
| Accuracy | High (θ=0.5: ~1-2% error vs brute-force) |
| Complexity | O(n log n × steps) |
| Interactions | ~O(n log n) per step (varies with particle distribution) |
| Best For | Medium-to-large N (64-2048), best accuracy/cost tradeoff |
| Weakness | Tree construction overhead for very small N |
