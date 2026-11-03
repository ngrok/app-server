---
"@ngrok/app-server": patch
---

Fix a crash, a file leak, and a build exposure, and make each request cheaper.

- On Node.js 26, a static file response that a later stage dropped unread, such as when a plugin threw after `next()`, crashed the process at garbage collection. The node host now opens a file at the first read, and the gzip stream, the access log, and the `runtimeEnv()` script injection read only when the client reads.
- A static file response never sends more bytes than its `Content-Length`, even when the file grows after the lookup.
- `nodeFiles().stat()` throws a file system error that does not mean a missing file, such as `EACCES` or `ELOOP`, so the request gets a logged 500, not a silent miss. `nodeFiles().open()` throws for a file that it cannot read, so the request gets a logged 500, not a 200 whose body fails.
- `streamingCompress()` sends a body whose `Content-Length` is under 1,024 bytes as it is. Gzip made such a body larger. It adds `Accept-Encoding` to `Vary` once, and only on a type that it can gzip, so an image no longer splits a CDN cache.
- The static stages hash the `etagPart` values once, not for each static file request.
- The `appServer` Vite plugin fails the build when the server build is inside the client build. Development does not check, because it serves no build directory. Before, the static stages could serve the server's code, or the whole file system when both builds used one directory.
- The `appServer` Vite plugin records the captured headers of a prerendered path with a non-ASCII character, such as `/café.json`, under the decoded path that the server looks up.
- The stale-build client no longer fails a request when `onNewBuild` throws: it reports the error. It reloads a document that the back/forward cache shows again after a move to a new build, and it does nothing on the server.
- `app-server` accepts `-p` for `--port` and `--help`. A bad argument writes a message and the usage, not a stack trace.
