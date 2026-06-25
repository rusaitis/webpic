"""Compute pypic golden outputs for the webpic compute-parity fixtures.

Invoked by scripts/gen-fixtures.ts (the TS orchestrator owns provenance + file placement); kept in
Python because the authority is numpy. Reads a request from stdin and writes the goldens to stdout::

    request : {"shape": [nx, ny, nz],
               "spacing": [d1, d2, d3],
               "components": {"B_1": [...], "B_2": [...], "B_3": [...]},   # flat, C-order
               "recipes": ["|B|", "div_B", "curl_B_1", ...]}
    response: {"pypicVersion": "0.1.0",
               "goldens": {"|B|": [...], "div_B": [...], ...}}             # flat, C-order, f64

The caller passes the EXACT f64 input arrays the webpic backends are tested on, so this isolates the
comparison to operator arithmetic (identical np.gradient edge_order=1 stencil on both sides → only
the f64 rounding gap remains). Run via: uv run --project ../pypic python scripts/pypic_goldens.py
"""

from __future__ import annotations

import importlib.metadata
import json
import sys

import numpy as np

from pypic import derived, diagnostics
from pypic.compute import RECIPES
from pypic.coordinates import operators
from pypic.coordinates.geometry import GeometryType

_CURL = {"curl_B_1": 0, "curl_B_2": 1, "curl_B_3": 2}


def _check_wiring() -> None:
    """Fail loudly if pypic re-points a recipe — a silently-wrong golden is worse than a crash."""
    assert RECIPES["|B|"].func is derived.magnetic_field_magnitude, "|B| rewired"
    assert RECIPES["div_B"].func is diagnostics.div_b, "div_B rewired"
    for key, idx in _CURL.items():
        assert RECIPES[key].func is operators.curl, f"{key} rewired"
        assert RECIPES[key].component == idx, f"{key} component drift"
        assert RECIPES[key].fields == ("B_1", "B_2", "B_3"), f"{key} inputs drift"


def main() -> None:
    req = json.load(sys.stdin)
    nx, ny, nz = req["shape"]
    d1, d2, d3 = req["spacing"]
    components = req["components"]
    recipes = req["recipes"]

    _check_wiring()

    def component(name: str) -> np.ndarray:
        # reshape((nx, ny, nz)) is C-order: element [ix,iy,iz] at flat iz + nz*(iy + ny*ix), the
        # exact layout webpic's sampleScalar writes and partialAlongAxis strides over.
        return np.asarray(components[name], dtype=np.float64).reshape((nx, ny, nz))

    b1, b2, b3 = component("B_1"), component("B_2"), component("B_3")
    cartesian = GeometryType.CARTESIAN
    # The full curl vector once (all three components share it), only if a curl recipe was asked for.
    curl_vector = (
        operators.curl(b1, b2, b3, d1, d2, d3, geometry=cartesian)
        if any(key in _CURL for key in recipes)
        else None
    )

    out: dict[str, list[float]] = {}
    for key in recipes:
        if key == "|B|":
            field = derived.magnetic_field_magnitude(b1, b2, b3)
        elif key == "div_B":
            field = diagnostics.div_b(b1, b2, b3, d1, d2, d3, geometry=cartesian)
        elif key in _CURL:
            assert curl_vector is not None  # set above whenever any curl recipe is requested
            field = curl_vector[_CURL[key]]
        else:
            raise SystemExit(f"pypic_goldens: unsupported recipe {key!r}")
        out[key] = np.asarray(field, dtype=np.float64).ravel(order="C").tolist()

    json.dump({"pypicVersion": importlib.metadata.version("pypic"), "goldens": out}, sys.stdout)


if __name__ == "__main__":
    main()
