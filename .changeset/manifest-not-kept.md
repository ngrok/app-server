---
"@ngrok/app-server": patch
---

The production server no longer keeps the bytes of `.app-server.json` in memory after startup. It read the build manifest through the store of small files, which keeps each file up to 256 KiB for the life of the process, and no request reads the manifest again. The bytes also no longer count in the 32 MiB that the store allows.

For a build with 302 prerendered paths, each server process and each Vercel Function instance now holds 110,250 bytes less, which is the size of that manifest. The number comes from `process.memoryUsage().arrayBuffers`, read after a garbage collection, before and after the setup, on Node.js 26.13.
