---
"@ngrok/app-server": patch
---

The package no longer publishes source maps. The packed size goes from 321.7 kB to 149.4 kB, and the size on disk from 1,067.6 kB to 481.3 kB, in 72 files in place of 112. The numbers are `size`, `unpackedSize`, and `entryCount` from `npm pack --dry-run --ignore-scripts --json` after `pnpm run build`, not gzip of single files.

A stack trace through the package now names the file in `dist`, such as `dist/create-server-<hash>.js:1275:10`. Before, with source maps on, as `app-server serve` sets them, it named a file that the package does not contain, such as `src/core/create-server.ts:71:10`. The files in `dist` are not minified.
