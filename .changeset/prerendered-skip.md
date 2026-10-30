---
"@ngrok/app-server": patch
---

Add the `skip` option of `prerendered()`. A request path that `skip` matches goes to the framework with no file lookup, so the app's auth check runs for a private page. The README has a new "Protect pages" section: a prerendered file answers before the app's routes, so an auth check goes in `beforeStatic` or the page goes in `skip`.
