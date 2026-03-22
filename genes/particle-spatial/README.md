# particle-spatial

Spatial hash grid N-body simulation — a pure-computation Native Gene for the Rotifer Protocol.

## Algorithm

Partitions space into a uniform grid of fixed-size cells. For each particle, only computes gravitational forces from particles in the same cell and 8 neighboring cells (3×3 neighborhood). Long-range forces beyond the cell neighborhood are ignored.

Cell size is adaptive: `cellSize = max(2ε, 2 × √(area / n))`, scaling with the average inter-particle spacing and bounded by the softening parameter.

Integration uses the symplectic leapfrog (kick-drift-kick) scheme.

This approach trades long-range gravitational accuracy for raw speed — achieving near-O(n) performance when particles are roughly uniformly distributed. It's better suited for short-range-dominated systems (collisions, dense clusters) than for orbital mechanics where long-range gravity dominates.

## Usage

```bash
# Cluster preset (good fit for spatial hashing)
rotifer run particle-spatial --input '{"preset": "cluster", "count": 256}'

# Collision (where short-range forces dominate)
rotifer run particle-spatial --input '{"preset": "collision", "count": 512, "steps": 300}'

# Solar system (less accurate due to missing long-range forces)
rotifer run particle-spatial --input '{"preset": "solar"}'
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
- `interactions_computed` — total neighbor-cell force evaluations

## Fitness Characteristics

| Metric | Expected |
|--------|----------|
| Success Rate | 1.0 (deterministic, no failure mode) |
| Accuracy | Low-medium (only short-range interactions, misses distant forces) |
| Complexity | ~O(n × steps) for uniform distributions |
| Interactions | Depends on particle clustering — much fewer than n² |
| Best For | Large N with short-range dominated interactions (collisions, dense clusters) |
| Weakness | Poor for orbital/long-range gravity (solar, binary) |
