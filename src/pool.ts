/**
 * Bounded-concurrency map. Shared so the contract judge and the rule judge do
 * not each carry their own copy.
 *
 * Only for work that is safe to run in parallel. Mutation grounding writes to
 * real source files and must stay strictly serial, so it does not use this.
 */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  /**
   * Epoch ms after which no new item starts; work already running finishes.
   * Items never started are left undefined in the results.
   */
  deadline?: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        if (deadline !== undefined && Date.now() >= deadline) return;
        const index = cursor++;
        results[index] = await fn(items[index]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
