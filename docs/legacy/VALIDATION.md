# Archived Validation Notes

The former version mixed public commands with private instance counts, host configuration, and historical evaluation claims. Those claims are not a reproducible public baseline.

For a clean public checkout, use the commands documented in the current README and evaluate only with the frozen datasets and metric definitions in [eval/METRICS.md](../../eval/METRICS.md). Report the dataset hash, parameters, environment, and result file fingerprint; do not publish questions, memory text, or retrieved snippets from a private instance.

A successful command is not proof of a successful integration. The host must also demonstrate that the selected instance can read and write through the intended adapter, with failures visible to the operator.
