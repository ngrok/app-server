---
"@ngrok/app-server": patch
---

The `prerendered paths with no file` warn line now has `app_server.missing_count`, and `app_server.missing_paths` names 20 of the paths at most. Before, the line had each path, so a server with no client build wrote each prerendered path of the site into one line.
