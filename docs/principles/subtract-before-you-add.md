# Subtract before you add

Before you add a rule, an option, a plugin, or a layer, look for one to remove. A change that deletes the cause of a problem beats a change that adds a guard around it.

**Why:** Additions stack up, and each one must justify its place every time someone reads it. A rule that nobody follows is a bug in the rule.

**Applies to:** code, prose.

**Signs you missed it:**

- A new option that turns off behavior that a removal would end.
- A plugin that undoes the work of another plugin, such as one that removes a header that an earlier stage set.
- A doc rule added beside an older rule that says the same thing.

**In this repo:** `defaultPlugins()` returns a plain array, so an app removes a stage with `filter`. Prefer that to a new on and off option.

**Enforced by:** review.
