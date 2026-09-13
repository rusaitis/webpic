---
description: Surface the relevant section(s) of docs/DESIGN.md on demand without loading the whole file
---

`docs/DESIGN.md` is the full design rationale for webpic (~880 lines). It is deliberately
**not** `@`-imported into context (it would bloat every session), so this command is the
intended way to read it: locate the relevant section(s) and pull only those into context.

Argument: `$ARGUMENTS` — a section name, topic, or keyword (e.g. "package shape",
"reduction round-trip", "perf gate", "remote", "tolerances", "M2"). May be empty.

Steps:

1. Run `grep -n '^#' docs/DESIGN.md` to get the section/heading map with line numbers.
2. If `$ARGUMENTS` is empty: print the heading map as a table of contents and stop — let
   the user pick. Do not dump the whole file.
3. If `$ARGUMENTS` is given: pick the best-matching heading(s). Match generously —
   "perf" → "Performance gate", "round-trip" → "Reduction provenance round-trip",
   "Mn" → that milestone's row in §Milestones. If a keyword spans several sections,
   `grep -n` for it and report each hit's section.
4. `Read` only the matched section(s) (use the line range from the heading map — from the
   matched heading to the next `#` of equal-or-higher level). Never read the entire file
   to answer a scoped question.
5. Summarize the section's key points, then quote the specific lines the user needs.
   Reference as `docs/DESIGN.md:<line>` so they're clickable.

If the topic isn't in DESIGN.md, say so plainly and suggest the closest section rather
than inventing rationale. DESIGN.md is the authority — don't paraphrase it into something
it doesn't say.
