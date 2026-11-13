---
"@ngrok/app-server": patch
---

On a serverless host, such as Vercel, a request no longer waits for the setup after the setup ends. The entry's `fetch` waited for the promise of the setup through three promises on each request. Now the first request runs each plugin's `setup`, and each later request goes to the app at once. A `setup` that throws still runs again on the next request, and the log still gets the `setup failed` line.

Each request makes 6 fewer promises: 165 before and 159 after through the Vercel handler with `defaultPlugins()`, counted with `async_hooks` for 5,000 requests on `node:http`. For an app with no plugins, `entry.fetch` in process costs 2.33 µs before and 2.13 µs after, as the median CPU time of 41 interleaved rounds of 30,000 requests on Node.js 26.13 and an Apple M3 Max. Through HTTP, the change in the CPU time of a request is less than the noise of the measurement, which is about 1%.
