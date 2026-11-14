// Stands in for the browser in the `app-server start` check in `test/runtimes.ts`: Vite runs a
// `BROWSER` script with the URL as its last argument, and this script writes the URL as a log line.
process.stdout.write(
	`${JSON.stringify({ level: "info", message: "browser opened", url: process.argv.at(-1) })}\n`,
);
