---
"@ngrok/app-server": patch
---

An own `kind` field of an error no longer replaces `error.kind`, so `error.kind` is always the error's name. A field that a `log.error` hook gives no longer replaces another attribute of the line, such as the request's `http.method`. The `log.attributes` hook runs last and can still change each field.
