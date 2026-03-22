# evolve.life

Conway's Game of Life simulator — a pure-computation Native Gene for the Rotifer Protocol.

## Why

The Game of Life is the quintessential cellular automaton: dead-simple rules produce emergent complexity. It maps perfectly to Rotifer's biological metaphor — cells live, die, and evolve through generations, just like Genes in the Arena.

As a **Native Gene**, `evolve.life` performs zero I/O. It compiles to sandboxed WASM and runs deterministically, making it an ideal benchmark for IR compilation, Arena fitness scoring, and cross-Binding portability.

## Usage

```bash
# Run with a preset pattern
rotifer run evolve.life --input '{"preset": "r-pentomino", "generations": 500}'

# Benchmark: 512x512 grid, 1000 generations
rotifer run evolve.life --input '{"width": 512, "height": 512, "generations": 1000, "preset": "random", "seed": 7}'

# Custom rule (HighLife: B36/S23)
rotifer run evolve.life --input '{"preset": "random", "rule": "B36/S23"}'
```

## Presets

| Preset | Type | Description |
|--------|------|-------------|
| `glider` | Spaceship | Moves diagonally, period 4 |
| `blinker` | Oscillator | Period 2, simplest oscillator |
| `beacon` | Oscillator | Period 2, 2x2 block pair |
| `pulsar` | Oscillator | Period 3, highly symmetric |
| `r-pentomino` | Methuselah | 5 cells → 1103 generations to stabilize |
| `random` | Soup | Seeded 35% density fill |

## Output

- `final_grid` — grid state after simulation
- `alive_count` — live cells at end
- `peak_population` — maximum live cells observed
- `stabilized_at` — generation where grid reached equilibrium (-1 if not)
- `extinction` — whether all cells died
- `cells_processed` — total cell evaluations (for benchmarking)
- `ascii_snapshot` — ASCII art of final state (max 80×40)

## Fitness Characteristics

| Metric | Expected |
|--------|----------|
| Success Rate | 1.0 (deterministic, no failure mode) |
| Latency | <50ms for 64×64×100, ~2s for 512×512×1000 |
| Resource Cost | O(w × h × g) memory: O(w × h) |
| Robustness | Handles all edge cases (empty grid, max size, custom rules) |
