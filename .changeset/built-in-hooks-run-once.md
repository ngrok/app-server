---
"@ngrok/app-server": patch
---

The static stages and `streamingCompress()` now run the header hooks on a view only when an app plugin uses `withHeaderHook`. Before, they ran each hook on a view for each file with a compressed copy and for each response that `streamingCompress()` compresses, to find a `no-transform`, a `Content-Encoding`, or a `Content-Range` from a hook. No hook of a built-in plugin sets these. So with only built-in plugins, each hook now runs one time, where the response leaves. No response changes.

An app hook keeps its contract. When a request has one, each hook of the request still runs on the view, so the app hook can read a header that a built-in hook sets. The `paths` of `buildId()` and the `policy` of `contentSecurityPolicy()` run in a built-in hook. With no app hook, they now run one time for these responses.

In process, with the default plugins and a `ResponseEdge` as the node listener calls the server (3 processes for each request, each with 60 pairs of 500 requests after a warm-up, the build before and this change in turn; Node.js 26.13, Apple M3 Max, with other load on the machine):

- A prerendered page with a brotli copy takes 0.954 to 0.981 of its time before: 0.17 µs to 0.59 µs less of 15.8 µs.
- A hashed asset with a copy takes 0.958 to 0.977: 0.39 µs to 0.86 µs less of 15.4 µs.
- A 304 for the page takes 0.966 to 0.969: 0.41 µs to 0.75 µs less of 13.3 µs.
- Each of the three allocates 1.4 KB to 1.6 KB less on the heap, which is about 3.5%, in 57 to 60 of the 60 pairs.
- A rendered page that `streamingCompress()` compresses allocates 2.4 KB to 2.8 KB less of 60.5 KB (3 processes, each with 40 pairs of 300 requests). The change in its time is inside the noise of brotli.
- With one app hook before the default plugins, the time and the heap of the page and the asset stay the same: the difference is inside the noise in 6 processes.
