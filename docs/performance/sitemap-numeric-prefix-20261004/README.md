# Numeric sitemap URL-prefix reuse

Measured 2026-10-04 at 13:54:36 UTC with Node v22.16.0, Linux x64,
Intel Xeon Platinum 8573C. This measures the complete `buildSitemapXml`
function in `src/lib/seo/sitemapOrigin.ts`, not HTTP, database or CDN latency.

## Change

The builder lazily resolves and XML-escapes the `prompts/` prefix once for
nonempty ASCII-decimal IDs. Numeric strings and positive bigint IDs then append
their already-safe digits. Other IDs retain the original encoding and URL
resolution path, including dot segments, escaped separators, XML characters,
Unicode and terminal newlines. Empty and inactive-only inputs do not create a
prompt prefix. No persistent cache is added.

All source preceding `buildSitemapXml` is byte-identical: origin validation,
Host/Forwarded independence, cache policy, general URL construction and XML
escaping are unchanged. Filtering, order, lastmod and ranking priorities stay
unchanged. This continuation preserves the earlier bigint compatibility fix.

## Source identity

Parent: `0af63e904f46046b31c02bd21c63aeaa8937fb5c`.
Before source blob: `76f982806de6bbde18a0d14914551992612ada9b`.
Executed candidate source blob: `6cdef00b7a018488f08ad36588c4bf0833fdf0d0`.

The program imports both complete source modules with Node's native type
stripping; it does not rewrite the implementation. One mixed boundary fixture
matched byte-for-byte, malformed Unicode retained its URIError, and the five
workload XML outputs matched. Inputs were frozen. There was no install, Vitest,
full package suite, typecheck, build, network, database or provider execution.

## Results

Medians of nine alternating paired samples after three warmups per version.
Each sample averages the indicated number of complete builder calls.
URL-construction counts were collected separately, outside timed samples.

| Workload | Calls per sample | Before ms | After ms | URL constructions before / after |
| --- | ---: | ---: | ---: | ---: |
| Empty | 1000 | 0.003817 | 0.002929 | 2 / 2 |
| 100 numeric strings | 10 | 0.177309 | 0.025077 | 102 / 3 |
| 10,000 numeric bigints | 1 | 21.611165 | 3.275659 | 10,002 / 3 |
| 10,000 nonnumeric IDs | 1 | 26.350935 | 24.136296 | 10,002 / 10,002 |
| 10,000 inactive entries | 10 | 0.408729 | 0.365754 | 2 / 2 |

The 10,000-numeric workload improved by 6.60x in this local run. The controls
retain their original URL-construction work; their timing variation is not an
optimization claim. No universal speedup, provider-quota saving or whole-page
latency improvement is inferred. Raw paired samples are in `results.csv`.

## Reproduce

From a checkout retaining the parent and this source, with Node v22.16.0:

```sh
tmp=$(mktemp -d)
git show 76f982806de6bbde18a0d14914551992612ada9b > "$tmp/before.ts"
git show 6cdef00b7a018488f08ad36588c4bf0833fdf0d0 > "$tmp/after.ts"
node --experimental-strip-types docs/performance/sitemap-numeric-prefix-20261004/benchmark.mjs \
  "$tmp/before.ts" "$tmp/after.ts" "$tmp/results.json"
```

The JSON output records exact source hashes, output hashes, correctness checks,
raw timings, runtime and the separately instrumented URL-construction counts.
Elapsed times vary with runtime and load. Round zero measures before then after;
subsequent rounds alternate order. No new application test runner or workflow
is introduced.
