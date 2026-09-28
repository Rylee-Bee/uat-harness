# Acceptance criteria

Each criterion is a **symbolised triple**, not prose:

```
description / action / machine-checkable expected
```

- **description** — what the check is about, in a few words.
- **action** — the one thing done to the page (`click …`, `type … into …`, `load …`).
- **machine-checkable expected** — a result a machine can decide true/false, written **only**
  in the assertion vocabulary below.

**The rule: no free-text verdicts.** An expected value like "works correctly", "looks right",
"seems usable", or "user is happy" is not an acceptable assertion — if a machine can't decide
it from the page, it isn't acceptance criteria, it's an opinion. Split it until every expected
value is one of:

```
visible | contains text | value equals | URL is | focus is on | axe has 0 critical | request returned N
```

**Format (one triple per line, code-fenced or table):**

```md
note appears after submit / click "Send" / URL is /thanks
hidden note toggles / click "Show note" / visible: #notes
hit areas are fingertip-sized / load the page / axe has 0 critical
```

Map triples to a URL from a [journey](../journeys/README.md) and a [persona](../personas/README.md).
The driver's raw findings (PROBLEM / note) are the evidence for these; the driver itself never
issues a verdict.
