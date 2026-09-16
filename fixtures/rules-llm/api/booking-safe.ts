/**
 * Clean control for data.tx.no-read-then-write-race.
 *
 * Same feature, same repository, same transaction. The difference is that the
 * decision and the write are one conditional update: the guard lives in the
 * WHERE clause and the affected row count decides the outcome, so two
 * concurrent callers cannot both succeed.
 */
import { withTransaction, seatRepo } from "./repositories/seatRepo";

export async function bookSeat(slotId: string, userId: string) {
  return withTransaction(async () => {
    const claimed = await seatRepo.decrementIfAvailable(slotId);

    if (claimed === 0) {
      return { ok: false, error: "SOLD_OUT" };
    }

    await seatRepo.addBooking(slotId, userId);
    return { ok: true };
  });
}
