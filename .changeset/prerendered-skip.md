---
"@ngrok/app-server": patch
---

Add the `skip` option of `prerendered()`. A path that `skip` matches goes to the app with no file lookup, so the app's auth check runs. A prerendered file answers before the app's routes, so a private page needs `skip` or an auth check in `beforeStatic`. The new "Protect pages" README section shows both.
