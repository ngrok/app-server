// A CommonJS package that `test/fixtures/react-router` keeps in `ssr.external`. It reads a file
// next to it, so it works only when the build copies the whole package.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

exports.greeting = () => readFileSync(join(__dirname, "greeting.txt"), "utf8").trim();
