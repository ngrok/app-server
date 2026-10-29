# Make illegal states unrepresentable

Model a contract in the types so that the compiler rejects a wrong use. What the types cannot catch fails loudly, at startup when it can.

**Why:** A type error shows at the call site, before the code ships. A runtime check shows only on the path that a test or a request happens to reach.

**Applies to:** code.

**Signs you missed it:**

- Two optional options that are valid only together, or never together.
- A string option that accepts any value but handles three.
- A field that exists in one mode but has an optional type in every mode.
- A `value as Type` assertion that silences an error instead of fixing the model.

**In this repo:** `SetupInfo` is a union on `mode`, so only development code can read `devServer`.

**Enforced by:** `pnpm run typecheck` with the strict options in `tsconfig.json`; oxlint `typescript/no-unsafe-type-assertion` and `typescript/switch-exhaustiveness-check`.
