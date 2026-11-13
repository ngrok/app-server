---
"@ngrok/app-server": patch
---

`prefersMarkdown()` now reads `Accept` with Hono's parser, which the server already uses for `Accept-Encoding`. For an `Accept` that names markdown, it takes about half the time: 1,421 ns to 781 ns for `text/markdown, text/html;q=0.9, */*;q=0.8`. The numbers are the medians of 11 interleaved rounds of 300,000 calls, with the build of `main` and this build in one Node.js 26.13 process. A browser's `Accept` names no markdown, so the server does not parse it, as before.

One answer changes: a `charset` parameter with no value, such as `text/markdown;charset=""`, or with text after its closing quote, now counts as no charset, so the range matches. Before, the range did not match.
