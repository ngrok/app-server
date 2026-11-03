---
"@ngrok/app-server": patch
---

In production, the server lists the client build once at start, and the static stages find each file in that list. A request no longer calls `stat` on the disk, also when no file matches it. A small route answers about 30% more requests each second on Node.js.

A file that you add to the client build or remove from it while the server runs no longer changes what the server serves. Restart the server after you change the build. If the walk gets an error that does not mean a missing file, such as `EACCES` or `ELOOP`, the server does not start, and the error names the path. A host adapter can give the same list through the new optional `StaticFiles.snapshot()`.
