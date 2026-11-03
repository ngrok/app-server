---
"@ngrok/app-server": patch
---

A `RegExp` or a function in the bundler's `external` option now keeps the peers of the packages it matches external. The build tests it on the name of each package in the app's dependencies. Before, the external package and the bundle could each get their own copy of a peer, such as `react`, or the server could not find the peer at run time.
