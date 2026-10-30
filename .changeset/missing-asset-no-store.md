---
"@ngrok/app-server": patch
---

Send `Cache-Control: no-store` with the 404 for a missing `/assets/*` file, so a CDN does not keep the miss. The README has a new "Deploys and open tabs" section: keep the old assets for 7 days after a deploy, so an open tab keeps working.
