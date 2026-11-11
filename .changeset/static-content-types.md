---
"@ngrok/app-server": patch
---

The static stages now send the type that `express.static` sent for more file extensions. Before, such a file went out as `application/octet-stream`, so a browser downloaded it, and the server did not compress it:

- `.sh`: `application/x-sh`
- `.yaml` and `.yml`: `text/yaml; charset=utf-8`
- `.rss`: `application/rss+xml`
- `.atom`: `application/atom+xml`
- `.pem`: `application/x-pem-file`
