---
"@ngrok/app-server": patch
---

`app-server start` now sends the `contentSecurityPolicy` for an HTML file in Vite's public directory, such as `public/offline.html`, with the hashes of its inline scripts. Before, the file got no policy in development, so a script that production blocks ran. `devServerStage` takes the new `publicDirectory` option for this.
