---
"@ngrok/app-server": patch
---

A failed start now writes one `startup failed` line to the log, with the level `error` and the `error.*` fields, before `start()` of the server entry rejects. A start fails when the setup throws, such as the `setup` of a plugin, or when a listener does not start, such as for a port in use or a bad `PORT`. The line goes to the `logger` sink of the app, through its `log` hooks. Before, the error went only to stderr, as the crash output of the runtime, with no level and no time.

The crash output and the exit code 1 do not change. If your own entry catches the error of `start()` and logs it, the log now has two lines for one failure. If you alert on `error` lines, a crash loop now raises that alert.

The copy of the package in the server build writes the line, so build the app again to get it.
