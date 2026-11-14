---
"@ngrok/app-server": minor
---

**Breaking:** the access line attribute `http.client_aborted` is now `http.aborted`. Why: the attribute is also `true` when the server stops the body, such as a body that fails after its first chunk, or a response that the drain deadline cuts. An operator who dropped these lines as client noise also dropped the responses that the server broke. A 5xx whose client left before the app answered logs as `499`, so that line still tells a client abort from a server fault.

Before:

```txt
@http.client_aborted:true
```

After:

```txt
@http.aborted:true
```

Change each Datadog query, monitor, and dashboard that uses `@http.client_aborted`. A query on the old name finds nothing, with no error.
