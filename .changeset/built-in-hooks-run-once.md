---
"@ngrok/app-server": patch
---

The static stages and `streamingCompress()` now run the header hooks on a view only when the request has a hook that a built-in plugin did not add. Before, they ran each hook on a view for each file with a compressed copy and for each response that `streamingCompress()` compresses, to find a `no-transform`, a `Content-Encoding`, or a `Content-Range` from a hook. No hook of a built-in plugin sets these. So with only built-in plugins, each hook now runs one time, where the response leaves. No response changes.

An app hook keeps its contract. When a request has a hook from `withHeaderHook`, or a hook that a stage adds to `headerHooks` itself, each hook of the request still runs on the view. So the app hook can read a header that a built-in hook sets. The `paths` of `buildId()` and the `policy` of `contentSecurityPolicy()` run in a built-in hook. With no app hook, they now run one time for these responses.

In process, with the default plugins and a `ResponseEdge` as the node listener calls the server (3 processes for each kind of request, each with 60 pairs of 500 requests after a warm-up, the build before and this change in turn; Node.js 26.13, Apple M3 Max, with other load on the machine). Each time and each heap size is the median of the differences of the pairs in a process:

- A prerendered page with a brotli copy takes 0.23 µs to 0.55 µs less of 15.4 µs.
- A hashed asset with a copy takes 0.37 µs to 0.48 µs less of 14.9 µs.
- A 304 for the page takes 0.54 µs to 0.61 µs less of 13.0 µs.
- Each of the three allocates 1.2 KB to 1.5 KB less on the heap, which is about 3%, in 57 to 60 of the 60 pairs.
- A rendered page that `streamingCompress()` compresses allocates 2.7 KB to 3.0 KB less of 60.8 KB, in each pair (3 processes, each with 40 pairs of 300 requests). The change in its time is inside the noise of brotli.
- With one app hook before the default plugins, the page and the asset stay the same: in 6 processes, the mean difference is inside 0.25 µs and 0.12 KB, in both directions.
