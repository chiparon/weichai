# Evaluation tests

`SmokeTests.cs` is the only public contract check. Hidden tests are generated
from `tasks/coverage-matrix.json` and stay outside the agent workspace during
the comparison. Each hidden test maps to one acceptance condition in
`tasks/task-manifest.json`; a task's requirement score is the fraction of its
conditions that pass.
