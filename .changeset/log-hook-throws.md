---
"@ngrok/app-server": patch
---

A `log.attributes` or `log.error` hook that throws no longer stops the log call. Before, the throw left the log call: a route that called `logger().info()` answered 500, a request lost its access line, and a route that threw answered 500 with an empty body and no `unhandled error` line.

Now the line goes out with `log.error`, such as `the attributes hook of the log option threw: <message>`, in place of the fields that the hook was to give. For `attributes`, that is each attribute of the line. For `error`, that is the fields of that error. The server does not write the fields that the hook got, because a hook can redact a value.
