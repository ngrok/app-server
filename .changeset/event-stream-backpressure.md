---
"@ngrok/app-server": minor
---

**Breaking:** `eventStream()` takes `produce` first and its options last, and `send()` returns a promise that an app can await.

- `send()` resolves when the client has read the earlier events down to 64 KiB of unread bytes, or when the stream ends. It never rejects. A producer that awaits it slows down for a slow client, so the server keeps little in memory. Before, the events that a client did not read stayed in memory with no limit.
- A stream with more than 1 MiB of unread bytes stops: the response fails, and the producer's `signal` aborts with an error that says `Await send()`. Only a producer that does not await `send()` gets there.
- The heartbeat skips a ping while the client has unread events.

Before:

```ts
return eventStream({ signal: request.signal }, async ({ send, signal }) => {
	for await (const update of watch({ signal })) {
		send({ data: JSON.stringify(update) });
	}
});
```

After:

```ts
return eventStream(
	async ({ send, signal }) => {
		for await (const update of watch({ signal })) {
			await send({ data: JSON.stringify(update) });
		}
	},
	{ signal: request.signal },
);
```

With no options, `eventStream({}, produce)` is now `eventStream(produce)`.
