---
description: Audit TASKS.md, CLAUDE.md, and docs/DESIGN.md for mutual consistency and drift against pypic ground truth
---

Audit webpic's planning/convention docs for internal consistency and drift. Read-only by
default: report findings, propose fixes, apply them **only** if `$ARGUMENTS` contains
`--fix`. Otherwise leave the tree clean and let the user decide.

Sources of truth (in precedence order):
- `docs/DESIGN.md` — full design rationale; §Milestones is the long-form authority for the
  milestone table that `TASKS.md` mirrors.
- `CLAUDE.md` — conventions + layer model; must not contradict DESIGN.
- `TASKS.md` — the live milestone checklist; the short mirror of DESIGN §Milestones.
- `../pypic/CLAUDE.md` (sibling, read if present) — ground truth for canonical names and
  physics. webpic claims schema/name parity with pypic; flag any contradiction.

Read all of TASKS.md and CLAUDE.md, and the relevant sections of DESIGN.md (use the
`/design` access pattern — `grep -n '^#'` then read scoped sections; don't blindly read all
~880 lines unless a finding requires it).

Check for:

1. **Milestone parity** — TASKS.md milestones vs DESIGN §Milestones: same set, ordering,
   week ranges (continuous, non-overlapping), exit gates, and the v0.1 = M0–M4 + M6 / M5-
   deferred scope. Flag any milestone item or exit-gate clause in one but not the other.
2. **Cross-references resolve** — every "see §X", "M2 checkpoint", file path, or script
   name (`gen-schema.ts`, `check-boundaries.ts`, …) named in one doc exists/agrees in the
   others. A doc pointing at a step another doc doesn't track is a finding.
3. **Convention agreement** — CLAUDE.md rules (layer DAG, canonical names with literal
   pipes `|B|`, 1-indexed field names ↔ 0-indexed array components, dependency list, TS
   strictness) don't contradict DESIGN. Same dep set, same boundaries.
4. **pypic parity** — canonical names, the `Recipe` shape, reduction-attr fields, and
   reader-protocol names webpic claims to mirror actually match `../pypic/CLAUDE.md` (and
   note that line-number citations in DESIGN drift — verify by symbol, not line).
5. **Internal numbering** — checklist items stay sequentially numbered; no dangling
   references to renamed/removed items.

Output a short report grouped by **substantive** (contradicts another doc / breaks a
cross-reference) vs **cosmetic** (wording/parallelism) vs **informational** (additive, not
contradictory). For each: the conflict, the file:line, and the precedence-respecting fix
(prefer changing the mirror to match the authority, not vice-versa, unless the authority is
the one that's wrong).

If `--fix`: apply only the **substantive** fixes, show the diff, and leave cosmetic/
informational items as recommendations. Never edit `docs/DESIGN.md` to match a mirror
without flagging it — the design doc is usually the one that's right.
