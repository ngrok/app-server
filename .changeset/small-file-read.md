---
"@ngrok/app-server": patch
---

The node host reads a static file of up to 64 kibibytes (KiB) with one read. A static file that is not in memory, such as `/robots.txt`, answers about 10% more requests each second on Node.js.
