---
"@ngrok/app-server": patch
---

In production, the server keeps each static file up to 256 KiB in memory after the first read, up to 32 MiB in all. A later request or byte range needs no file read. A larger file streams from disk as before. On Node.js, `/robots.txt` answers about 50% more requests each second, and a small hashed asset about 55% more.
