# Handoff format

Fill this in, paste it into the PR description, and return it to the planner. Every field
is checked independently, so a gap you state here is diligence and a gap you leave out is
a defect.

```
TASK:        <id> — <one line>
BRANCH:      <branch name>
PR:          <url>
STATUS:      complete | complete-with-caveats | blocked

GATE:        node --check ✅   npm test: <N> passed, <N> failed, <N> skipped
             base: main at <sha> (rebased at handoff time)
             tests on main before: <N>   after: <N>   difference explained: <yes/why>
MIGRATION:   none | M-<n> — verified on an empty file AND on a populated file from the
             previous schema

SHARED FILES TOUCHED:
  <path> — what changed, and why it is additive
  (or: none)

CONTRACTS PUBLISHED / CHANGED:
  C-<n> <name> — matches docs/decisions.md as written, or: differs, because <reason>
  (or: none)

EXISTING TESTS MODIFIED:
  <path> — <old assertion> → <new assertion>; why this strengthens rather than weakens
  (or: none)

DECISIONS NEEDED FROM OPERATOR:
  none | <the question, and what you did in the meantime>

RISKS AND FOLLOW-UPS:
  What this does not cover. What was hand-verified versus tested. Residual risk, stated
  plainly.
```

Two fields matter most. **EXISTING TESTS MODIFIED** lets the reviewer judge strengthening
versus weakening without hunting for the change. **RISKS AND FOLLOW-UPS** is where an
honest gap gets checked instead of becoming an incident.
