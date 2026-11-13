# Explain the number

When you state a number (latency, throughput, memory, a size, a count), say how you got it and what it measures. Never state a number that you did not measure.

**Why:** A number reads as a fact. One with no method cannot be checked, and one that measures the wrong thing misleads the reader who acts on it.

**Applies to:** code, prose.

**Signs you missed it:**

- "Faster" in a changeset or a PR with no before and after.
- A requests-per-second figure with no tool, runtime, concurrency, or response size.
- A size with no note of gzip or no gzip.
- One run, when the spread between runs is larger than the change.
- A run of the base and then a run of the branch. A machine drifts between two runs, so run the two in turn and compare each pair.
- A change that ships with a gain inside the spread. If you cannot measure the gain, do not ship the change.

**In this repo:** changesets and PR descriptions. For a performance change, measure `main` and the branch with the same command on the same machine, and give the command. `node ./test/bench.ts --base <checkout>` runs the base and the head in turn for each route.

**Enforced by:** review.
