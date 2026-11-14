---
"@ngrok/app-server": minor
---

Breaking change: `@ngrok/app-server/node` no longer exports `nodeFiles` and `parsePort`. Only the package used them, and the server entry of each node-host build held their code.

- For `nodeFiles(clientDirectory)`, use `host.files(clientDirectory)` from the same entry.
- `parsePort` has no replacement. `tcp()` reads and checks `PORT`.

```ts
// Before
import { nodeFiles } from "@ngrok/app-server/node";
const files = nodeFiles(clientDirectory);

// After
import { host } from "@ngrok/app-server/node";
const files = host.files(clientDirectory);
```
