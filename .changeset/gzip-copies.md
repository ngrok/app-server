---
"@ngrok/app-server": minor
---

The `appServer` Vite plugin now writes a gzip copy (`.<file>.gz`) next to each text file of 1 KiB or more in the client build, except HTML. The copy is a dotfile, so it has no URL of its own. `app-server serve` sends the copy to a client that accepts gzip, with its `Content-Length` and `Vary: Accept-Encoding`. The server no longer gzips these files for each request. A 19 KB script answers about 70% more gzip requests each second on Node.js, and it sends fewer bytes, because the build uses the highest gzip level.

`appServer()` now gives a list of Vite plugins. An app that puts it in `plugins` needs no change. Code that reads a hook from it, such as `appServer(options).load`, now reads it from the first item: `appServer(options)[0]?.load`.

If you keep the `/assets/*` files of old builds for open tabs, also keep their `.<file>.gz` copies.
