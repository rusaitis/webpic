"""Compute pypic golden field-line traces for the webpic tracing-parity fixtures.

Invoked by scripts/gen-trace-fixtures.ts (the TS orchestrator owns provenance + file placement); kept
in Python because the authority is pypic.traces. Reads a request from stdin and writes the traces to
stdout::

    request : {"grid": {"dimensions": [nx,ny,nz], "spacing": [d1,d2,d3], "origin": [o1,o2,o3]},
               "components": {"B_1": [...], "B_2": [...], "B_3": [...]},   # flat, C-order, f64
               "seeds": [[x,y,z], ...],
               "options": {"direction": "both", "maxStep": 0.05, ...}}     # camelCase, subset of opts
    response: {"pypicVersion": "0.1.0",
               "traces": [{"points": [...], "nPoints": N, "reason": "...",
                           "nSteps": M, "maxLocalError": e, "method": "rk45_dopri"}, ...]}

The caller ships the EXACT f64 field arrays the webpic interpolator is tested on; pypic rebuilds the
same cell-centered grid (GridInfo.coordinate_arrays) and traces with the same options, so the
comparison isolates the integrator + trilinear arithmetic. Run via:
    uv run --project ../pypic python scripts/pypic_trace_goldens.py
"""

from __future__ import annotations

import importlib.metadata
import json
import sys

import numpy as np

from pypic.dataset import FieldDataset
from pypic.grid import GridInfo
from pypic.traces import trace_field_line_adaptive

# webpic AdaptiveTraceOptions (camelCase) → pypic trace_field_line_adaptive kwargs (snake_case).
_OPT_MAP = {
    "atol": "atol",
    "rtol": "rtol",
    "stepSizeInit": "step_size_init",
    "minStep": "min_step",
    "maxStep": "max_step",
    "maxSteps": "max_steps",
    "direction": "direction",
    "nullThreshold": "null_threshold",
    "loopTol": "loop_tol",
    "loopMinArclen": "loop_min_arclen",
}


def _trace_one(data: FieldDataset, seed: list[float], options: dict) -> dict:  # type: ignore[type-arg]
    kwargs = {_OPT_MAP[k]: v for k, v in options.items()}
    fl = trace_field_line_adaptive(data, tuple(seed), **kwargs)
    return {
        "points": np.asarray(fl.points, dtype=np.float64).ravel(order="C").tolist(),
        "nPoints": int(fl.n_points),
        "reason": str(fl.metadata["reason"]),
        "nSteps": int(fl.metadata["n_steps"]),
        "maxLocalError": float(fl.metadata["max_local_error"]),
        "method": str(fl.metadata["method"]),
    }


def main() -> None:
    req = json.load(sys.stdin)
    grid_spec = req["grid"]
    nx, ny, nz = (int(n) for n in grid_spec["dimensions"])
    spacing = tuple(float(s) for s in grid_spec["spacing"])
    origin = tuple(float(o) for o in grid_spec["origin"])
    comps = req["components"]

    def component(name: str) -> np.ndarray:
        return np.asarray(comps[name], dtype=np.float64).reshape((nx, ny, nz))

    grid = GridInfo(dimensions=(nx, ny, nz), spacing=spacing, origin=origin)
    data = FieldDataset.from_arrays(
        {"B_1": component("B_1"), "B_2": component("B_2"), "B_3": component("B_3")},
        grid,
    )

    options = req["options"]
    traces = [_trace_one(data, seed, options) for seed in req["seeds"]]
    json.dump(
        {"pypicVersion": importlib.metadata.version("pypic"), "traces": traces},
        sys.stdout,
    )


if __name__ == "__main__":
    main()
