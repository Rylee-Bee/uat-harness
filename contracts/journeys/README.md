# Journeys

Jobs-to-be-done. A journey is **what a person is trying to accomplish**, written as a job, not as
a list of click paths — the driver discovers the actual clicks itself.

**Format:**

```md
# <journey name>

**Persona:** <link to ../personas/...>
**Job:** <one sentence — "as a <persona>, I want to <job> so that <outcome>">

1. <starting state — where the run begins>
2. <step a person would take, in their words>
3. <the outcome they need to reach>
```

Keep journeys to the length a person would describe out loud. Anything longer is a test case
belonging in that repo's own Playwright suite, not here.
