/**
 * Whether `work` settles before `ms` pass.
 *
 * @example
 * await settlesWithin(plugin.onShutdown(), 10_000); // => false for a hook that hangs
 */
export async function settlesWithin(work: Promise<void>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const settled = await Promise.race([
		work.then(() => true),
		new Promise<boolean>((resolve) => {
			timer = setTimeout(resolve, ms, false);
		}),
	]);
	clearTimeout(timer);
	return settled;
}
