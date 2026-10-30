---
"@ngrok/app-server": patch
---

Send `Cache-Control: no-store` with the 404 for a missing `/assets/*` file, so a CDN does not keep the miss after a deploy. The new "Deploys and open tabs" README section says to keep old assets for 7 days, so an open tab keeps working.
