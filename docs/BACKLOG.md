# uat-harness backlog

This file is the tracking doc for work that was open in GitHub Issues here and was closed as not
planned on 2026-10-07, so the issue queue could reach zero without losing the backlog.
The issue bodies were not edited or rewritten when they were closed; everything under each heading
is our own summary.
To restart an item, reopen the linked issue or open a new one describing the change, and delete the
corresponding section here.
It was built by a single rule: every issue open in this repository on 2026-10-07 is listed, newest
first, whatever its size.

### #5 — Research: domain player drivers as replayable UAT evidence, without making UAT a game framework

- Issue: https://github.com/Rylee-Bee/uat-harness/issues/5
- Opened: 2026-10-06 · Labels: none
- Status on 2026-10-07: closed as not planned on 2026-10-07 — tracked here

This issue asks for research into whether uat-harness can act as evidence for a domain-owned player
driver without taking on that domain's game semantics. It came out of a 2026-10-06 design session
between Rylee and Sol on a VEFR "Pass the Controller" / autoplay / troubleshooting idea, where VEFR
needs a player driver plus portable session and tape artifacts that VEFR itself owns. The stated
boundary is that uat-harness stays a general-purpose real-browser evidence collector and must not
learn VEFR maps, inventories, quests, combat, save formats or AI policy. The integration it
imagines is deliberately narrow: a domain repo drives its own app through a documented
player/action seam, while uat-harness keeps supplying the real Chromium context, desktop and mobile
surfaces, screenshots, video, Playwright trace, console and network evidence, and axe. Domain
artifacts, such as a VEFR session capsule, action tape, or checkpoint/divergence report, would sit
beside the existing UAT artifacts rather than replace them. The constraint is that this is research,
not a build request, and nothing in it should widen the driver's responsibilities.

Next step, when this is picked up: Reopen the issue and confirm VEFR still wants a documented player/action seam here before any design or code work.