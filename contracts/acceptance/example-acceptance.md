# Acceptance: smoke fixture

For [example-resume-a-task](../journeys/example-resume-a-task.md) against `fixtures/sample.html`.

| triple |
| --- |
| hidden note toggles / click "Show note" / visible: #notes |
| toggle reflects its state / click "Show note" / value equals: aria-expanded="true" |
| anchor jumps to its target / click "Jump to the notes anchor" / URL is: #x |
| text field accepts typing / type into #note-text / value equals: UAT test input |
| no fingertip-hostile targets / load the page / axe has 0 critical |
