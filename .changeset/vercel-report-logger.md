---
"@ngrok/app-server": patch
---

`vercel({ cdnPages })` now writes its report of the paths that the function serves through Vite's logger, so Vite's `logLevel` and `customLogger` apply to it. With a `logLevel` of `warn`, `error`, or `silent`, the report does not print. The report now names each path with its reason, as the README says. Before, it went to stdout and named the first 20 paths, so the reason for path 21 was in no file and in no log.

For a host adapter: `HostOutput` has a new `logger` field, Vite's logger, for what the host's `output` prints.
