import { describe, expect, it } from "vitest";
import { createServer } from "./create-server.js";
import { logger } from "./request-context.js";
import { withRequestContext } from "../testing/index.js";
import type { LogLevel, RequestLogger } from "./types.js";

/** Lines that a sink got, as `[level, message, attributes]`. */
type Line = [LogLevel, string, Readonly<Record<string, unknown>>];

describe("logger", () => {
	it("writes to the sink and hooks of the last createServer call outside a request", () => {
		const lines: Line[] = [];
		createServer({ plugins: [], logger: { log: () => {} } });
		createServer({
			plugins: [],
			logger: {
				log: (...line) => {
					lines.push(line);
				},
			},
			log: { attributes: (_level, _message, attributes) => ({ ...attributes, app: "web" }) },
		});

		logger().warn("cache cold", { error: new TypeError("miss") });

		expect(lines).toStrictEqual([
			[
				"warn",
				"cache cold",
				{
					"error.kind": "TypeError",
					"error.message": "miss",
					"error.stack": expect.any(String),
					app: "web",
				},
			],
		]);
	});

	it("gives the logger of the request inside a request", async () => {
		const requestLog: RequestLogger = { debug() {}, info() {}, warn() {}, error() {} };

		const inside = await withRequestContext({ logger: requestLog }, () => logger());

		expect(inside).toBe(requestLog);
	});
});
