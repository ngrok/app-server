---
"@ngrok/app-server": patch
---

The server and the build now compress more types. `streamingCompress()` compresses them, and the build writes a `.gz` and a `.br` copy of such a static file. The new types are each type with a `+json` or `+xml` suffix (such as `application/rss+xml`, `application/atom+xml`, and `application/ld+json`), `image/x-icon`, `image/vnd.microsoft.icon`, `image/bmp`, `font/ttf`, `font/otf`, `application/vnd.ms-fontobject`, `application/wasm`, `application/yaml`, `application/x-yaml`, and `application/x-sh`. For example, a browser asks for `favicon.ico` on each first visit, and the icon now gets a compressed copy. `font/woff` and `font/woff2` are compressed already and stay as they are.
