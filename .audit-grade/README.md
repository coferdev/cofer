# Audit evidence

Pre-audit reviews of this repository, kept with the code so anyone can see what was checked, what was found, what was fixed, and how the grade moved. Each review is tied to one commit.

**Latest: 9.0 / 10 on commit `18f8b7a`.** Read [REPORT.md](REPORT.md).

This is an automated pre-audit grade, not a substitute for a human audit.

## Files

| File | What it is |
| --- | --- |
| [REPORT.md](REPORT.md) | The latest report (the same text as the newest dated report below) |
| [REPORT-2026-11-05-18f8b7a.md](REPORT-2026-11-05-18f8b7a.md) | Rescore after bot-command tests, the large-outflow alert, and Slither and CodeQL in CI: **9.0** |
| [REPORT-2026-11-05-2eba701.md](REPORT-2026-11-05-2eba701.md) | Rescore after fixing M-1, L-1 and L-2 and adding the FeeRouter invariant test: **8.7** |
| [REPORT-2026-11-05-eeea299.md](REPORT-2026-11-05-eeea299.md) | Second full review: **8.2** |
| [REPORT-2026-11-01-6f19108.md](REPORT-2026-11-01-6f19108.md) | Rescore after the first review's fixes: **8.5** |
| [REPORT-2026-11-01-aba0779.md](REPORT-2026-11-01-aba0779.md) | First full review: **4.0** |
| [SCOPE.md](SCOPE.md) | Every file in scope at `18f8b7a`, with its git blob id and line count, plus what was not covered |
| [coverage.md](coverage.md) | Test coverage at `18f8b7a`: per file, and how the in-scope figure is worked out |
| [findings.tsv](findings.tsv) | Every finding ever raised, one row each, with its status (`open`, `fixed`, `accepted`, `false-positive`), severity, location, and the commits it was first and last seen on. Rows are never deleted. |
| [history.tsv](history.tsv) | The grade and the seven category scores at each review |

## How the grade works

Seven categories, each scored out of 10 against a fixed checklist, then weighted:

| Category | Weight |
| --- | --- |
| A. Contract security (findings deduct by severity) | 35% |
| B. Off-chain security: bot, signer API, relayer, keeper, supply chain | 15% |
| C. Testing and verification: tests pass, coverage, refusal tests, fuzz, stateful invariants, fork tests, CI | 15% |
| D. Privileged operations, deployment and monitoring | 10% |
| E. Dependencies and supply-chain hygiene | 5% |
| F. Repo hygiene and CI: secrets, CI tests, static analysis, Actions hardening | 10% |
| G. Docs, spec and threat model | 10% |

The total is rounded **down**. Caps then apply, and the lowest wins: any open Critical caps the grade at 3.0, two open Highs at 5.0, one at 6.0, failing tests at 6.0, a live deployment that doesn't match the audited build (or wasn't checked) at 7.0, and any open Medium at 8.9. A Medium or Low can be **accepted** only when [SECURITY.md](../SECURITY.md) states the risk and the reason; it then deducts less. Highs and Criticals can't be accepted.

A **full** review reads the code, runs every test in a clean copy of the commit, proves each Medium or worse finding with a runnable test, checks any live deployment, and ends with an independent second review that recomputes the grade. A **rescore** re-checks every open finding against the current code, reruns the scans and tests, and regrades without new hunting. A rescore that crosses 9.0 also gets the independent second review.

## Checking it yourself

- **Same code?** `git ls-tree -r 18f8b7a` lists every file with its blob id; compare with [SCOPE.md](SCOPE.md).
- **Tests:** `cd contracts && forge test -vv`, then `cd services && bun install --frozen-lockfile --ignore-scripts && bun run typecheck && bun test`.
- **Coverage:** the commands are in [coverage.md](coverage.md).
- **Fork tests** (read-only; they use a local copy of mainnet): `cd services && bun scripts/fork-swap-test.ts`.
- **Deployment check** (read-only), once mainnet is live: `cd services && bun run check-deploy ../contracts/deployments/4663.json`.

## Not published here

Each Medium or worse finding was proved with a runnable proof-of-concept test, kept privately. The reports refer to these as `PoCs/…`. They run only against local mocks and a throwaway database, never a live system. The owner can share them with a reviewer on request.
