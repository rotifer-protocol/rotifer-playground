# particle-brute

Brute-force N-body gravitational simulation — a pure-computation Native Gene for the Rotifer Protocol.

## Algorithm

All-pairs direct summation with O(n²) complexity per step. For each pair of particles (i, j), computes the exact gravitational force using Newton's law with a softening parameter to prevent singularities:

```
F = G × m_i × m_j × r̂ / (|r|² + ε²)^(3/2)
```

Integration uses the symplectic leapfrog (kick-drift-kick) scheme for energy conservation.

This is the **accuracy baseline** — every pairwise interaction is computed exactly, making it ideal for validating approximation-based algorithms like Barnes-Hut or spatial hashing.

## Usage

```bash
# Solar system preset (64 particles, 100 steps)
rotifer run particle-brute --input '{"preset": "solar"}'

# Cluster collision (128 particles, 500 steps)
rotifer run particle-brute --input '{"preset": "collision", "count": 128, "steps": 500}'

# Custom particles
rotifer run particle-brute --input '{"particles": [{"x":0,"y":0,"vx":0,"vy":0,"mass":100}, {"x":5,"y":0,"vx":0,"vy":4.47,"mass":1}]}'
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
- `interactions_computed` — total force evaluations (n(n-1)/2 × 2 × steps for kick-drift-kick)

## Fitness Characteristics

| Metric | Expected |
|--------|----------|
| Success Rate | 1.0 (deterministic, no failure mode) |
| Accuracy | Exact (machine-precision pairwise forces) |
| Complexity | O(n² × steps) |
| Interactions | n(n-1) × steps |
| Best For | Small N (≤256), accuracy benchmarks |
| Weakness | Scales poorly for large N |
