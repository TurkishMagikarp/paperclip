# Release-matched server read backport

Base: `d69631b01b9c658f80bf8bed389863dce82643e1`.
Branch: `perf/server-2026-1106-integration`.
No deployment, live-system change, merge, schema migration, UI change, or precompression.

## Port scope

- Upstream #17396 (`100477e887`): company-checked stored workspace reads for
  detail, heartbeat context, and closed-workspace guards; persisted runtime
  service summaries remain available. Explicit workspace/lifecycle safety
  inspection paths retain their live checks.
- Upstream #21713 (`30c4d2f4a`): reuse same-request authorized issue fields,
  recursive nearest-first ancestor query (50 maximum, visited-path cycle guard),
  omit the unused project provider catalog from the compact project embed, and
  avoid activity aggregates when the user has no inbox archive row. Optional
  known-row arguments are internal trusted database inputs, not request inputs;
  other callers retain the existing root reads and authorization owners.
- Upstream #17491 (`cb6c878c3`): select blocker-consumed lifecycle/process fields
  and typed context/profile evidence. Complete result JSON, native input and
  workspace-sync receipts remain intact. No retry, cancellation, lease, or
  workspace-repair policy was imported from a newer release.
- Fork PR2 (`a9f41d22b`): observe Express's serialized response for byte logging
  instead of serializing the issue list a second time.
- Fork PR3 (`815461013`, test normalization `3fb582d49`): run blocker and
  interruption presentation reads concurrently, only after recovery
  revalidation and edge redaction; include interruption in Server-Timing.
  An already-disconnected board skips the final reads; agents do not.

## Release adaptations

Cherry-pick conflicts were reviewed, not accepted wholesale. Newer chat
bootstrap/Mine endpoints, declined-interaction recording, child-task read
recording, stalled dependencies, other run projections, and newer schema
fields were not imported. The SQL/service code compiles against this release's
locked schema and unchanged recovery helpers.

The upstream JSON golden belongs to a newer schema. A detached worktree at the
exact release generated the replacement golden through the real session
middleware and PostgreSQL, before checking the optimized response. Only UUIDs,
timestamps, fixture prefix/user ID, and platform-dependent project folder paths
are normalized. No response fields are discarded.

## Runtime image overlay

Only these JavaScript files differ from a separate local release compilation:

```text
server/dist/routes/issues.js
server/dist/routes/issue-detail-tail.js                 (new)
server/dist/routes/issue-list-response-bytes.js         (new)
server/dist/services/execution-blocker.js
server/dist/services/execution-workspaces.js
server/dist/services/issue-references.js
server/dist/services/issue-thread-interactions.js
server/dist/services/issues.js
server/dist/services/projects.js
```

The narrowed cancelled-startup input type and timing phase union erase during
compilation, so their JavaScript needs no replacement. Test output is not part
of the image overlay. The archive is JS-only: declarations and debug source maps
are not included; do not treat pre-existing source maps as updated debugging
evidence for overlaid files. All other 1,389 emitted non-test runtime JavaScript files
are byte-identical between the two local builds.

This is local baseline parity, **not a claim of parity with a running image**.
The overlay manifest records old/new SHA-256 values so the rollout owner can
compare the actual image before applying the overlay.

## Build and verification

Dependencies use the release's frozen lockfile and a short Windows pnpm
virtual store. Generated prerequisite builds:

```text
node scripts/ensure-plugin-build-deps.mjs
node node_modules/typescript/bin/tsc -p packages/paperclip-eval-kernel/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/paperclip-runner/tsconfig.json
node node_modules/typescript/bin/tsc -p server/tsconfig.json
```

The server compilation also succeeds in the detached baseline worktree using
the same unchanged dependency builds. Initial attempts without Runner/eval
declarations failed; building those prerequisites resolved the errors, without
source changes or weakened compiler checks.

Completed recovery/serialization regression run: **328 tests in 6 files pass**:
`execution-blocker-read`, `explicit-native-continuation`,
`legacy-explicit-continuation-recovery`, `native-failed-workspace-recovery`,
`issue-list-response-bytes`, and `issue-detail-tail`. PostgreSQL projection
tests compare complete computed blockers with full-row reads, check current
process-state changes, company boundaries, typed pre-dispatch evidence,
native workspace field presence, malformed context, and unchanged stored rows.
Synthetic projected run reads are below 4 KiB versus full reads above 128 KiB.

Final focused run: **44 tests in 6 files pass**, covering the release-golden
detail response, authorization and immediate membership revocation,
nearest-first/cyclic/self-parent/55-level ancestor chains, interactions,
the expanded blocker differential cases (including cancelled continuation
with zero versus outstanding tools), serialization, final-read concurrency,
heartbeat task context, and referenced projects.

The exact-release baseline sends **71 statements** for the two-ancestor,
blocker/project-mention detail fixture. The backport sends **62**, with
byte-identical normalized JSON. The locked-release test budget is 62, rather
than copying the newer upstream release's 64-statement budget.

The wider run executed 13 suites: **402 passed, 48 failed, 1 unhandled error**.
This is not a green full-suite claim. One new census expectation assumed that
Agent Chat was enabled; the locked release disables it. The census now covers
the release's enabled board routes without enabling Chat. One existing workspace
activation test could not spawn `sh` on the default Windows PATH; a rerun adds
the installed Git shell to PATH without changing runtime code. The other 46
failures are in `workspace-recovery.test.ts`, primarily native Windows paths
rejected by the unchanged POSIX archive-confinement boundary. No confinement,
cleanup, or recovery safety check is weakened to accommodate this host.

The untouched release worktree reproduces **the same 46 workspace-recovery
failures and 5 passes**, with the same failing-case blocks and no
integration-only failures. Dependencies are shared with the integration
worktree, but all dependency package sources are unchanged from the release.
This establishes local baseline failure parity, not Linux acceptance. A clean
Linux workspace-recovery run remains an explicit rollout-validation limit.

The adapted board census and stored-workspace Git-inspection guard both pass
on rerun. Adding Git's `sh` resolves executable discovery, but the existing
runtime-spawn fixture still fails because shell quoting mangles its Windows
marker path. That test's process command and runtime launcher are unchanged;
no shell/path policy change is included in this performance backport.
The untouched release reproduces that same marker-path failure with Git's shell
on PATH. Thus the 47 remaining failing tests reproduce on the release baseline;
the added Chat census mismatch is resolved. Linux acceptance of these existing
workspace/process paths remains unverified and must not be reported as PASS.

Additional cancellation/provider-policy run: **25 tests in 2 files pass**
(`run-cancellation` and `project-workspace-provider.integration`).

The in-process issue-list benchmark (400 rows, 1,292,847 JSON bytes, 15 rounds,
20 iterations/round, Node 24.20.0, Express 5.2.1, Windows x64) measured median
response serialization/send CPU reductions of 36.3% for 200 responses and 41.5%
for unchanged 304 responses. This excludes database work, enrichment, socket IO,
and production traffic; it is not an end-to-end latency claim.

Full monorepo tests/build, Rust/vendor reconstruction, native runner execution,
browser qualification, live-image hash comparison, and deployed latency
measurement are not claimed. The overlay uses freshly emitted server JS and
retains the existing image's unchanged Runner/vendor tree.
