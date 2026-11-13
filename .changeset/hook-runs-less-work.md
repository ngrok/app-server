---
"@ngrok/app-server": patch
---

Two header hooks do less work on each run. The `buildId` hook no longer parses a `Server-Timing` header that the response does not have. The `Vary` check of `streamingCompress`, the static stages, and `noindex` no longer builds a `Set` to find one name.

On Node.js v26.13, one run of the `buildId` hook on a document costs about 60 ns less (about 15%), and one `Vary` check costs about 100 ns less (about 40%). Each leaves about 300 bytes less garbage. A hook runs one to three times for each response. The numbers come from 21 to 31 rounds that take turns between the build before and this one. For a full request, the gain is inside the noise. No header changes.
