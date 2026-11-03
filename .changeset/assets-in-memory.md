---
"@ngrok/app-server": patch
---

`assets()` keeps each `/assets/*` file up to 256 KiB in memory after the first read, up to 32 MiB in all. A hashed name means that the bytes never change, so later requests and byte ranges need no file read. A larger file streams from disk as before. A small asset answers about 70% more requests each second on Node.js.
