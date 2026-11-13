---
"@ngrok/app-server": patch
---

On the vercel host, a cold start of the function now reads one list of the files of its client build. Before, it read each directory and called `stat` for each file, and the time grew with each prerendered page, also for a page that the CDN serves.

`vercel()` writes the list to `.app-server-files.json` in the function's client build, in place of `.app-server-brotli.json`. The list has the size of each file that the function holds and the time of the build. The responses do not change: each file has the same headers, and its ETag still changes with each build.

For a React Router app with 2,000 prerendered pages (4,003 files in 2,002 directories in the function), the first request of a cold start takes 20 ms in place of 82 ms, which is 0.24 of the time. The function calls `stat` 1 time in place of 6,006 times, and `readdir` 0 times in place of 2,002 times. The second request takes 1.5 ms in place of 0.7 ms, because a garbage collection that ran in the first request now runs in the second. From the third request on, a request takes the same time. Each number is the median of 11 runs of each build in turn, each run in a new process, after 2 warm-up runs, and three such rounds gave ratios of 0.24, 0.24, and 0.24 (Node.js 26.13, macOS, Apple M3 Max, with the files in the file cache). The time on Vercel is not measured. The four file lookups of one page request take 235 ns in place of 985 ns. The list adds 122 KB to that function.

Three things change for an app:

- The function serves only the files that `vercel()` put in it. If a step after the build adds a file to `.vercel/output/functions/index.func`, the function does not serve that file. Before, it did.
- `.vc-config.json` has no `environment`, and the function no longer gets the `APP_SERVER_BUILT_AT` variable. The time of the build is in the list.
- The function's client build has `.app-server-files.json` and no `.app-server-brotli.json`.

The node host does not change.
