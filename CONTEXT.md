# Translation Verification

Translation verification evaluates translated behavior using host-recorded test executions and routes evidenced defects back to translation.

## Language

**Test report**:
An agent's explanation of observed test behavior. A report is a claim until compared with host-recorded execution evidence.

**Test evidence**:
The host's record of a test command, tested source snapshot, process outcome and available test-runner results.

**Repair feedback**:
A host-issued description of evidenced test failures sent to the translator. It refers to a specific test attempt and does not grant permission to alter the tests.

**Translation worktree**:
The complete project checkout used for translation and compilation. The testing and repair phases reuse that checkout before its owner releases it.
