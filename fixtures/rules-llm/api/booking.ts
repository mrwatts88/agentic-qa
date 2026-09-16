/**
 * VIOLATES data.tx.no-read-then-write-race.
 *
 * Two requests can both read "one seat left", both pass the check, and both
 * write. The transaction does not save it: neither sees the other's uncommitted
 * write under read committed.
 */
import { withTransaction, seatRepo } from "./repositories/seatRepo";

export async function bookSeat(slotId: string, userId: string) {
  return withTransaction(async () => {
    const slot = await seatRepo.findById(slotId);

    if (slot.seatsAvailable < 1) {
      return { ok: false, error: "SOLD_OUT" };
    }

    await seatRepo.update(slotId, { seatsAvailable: slot.seatsAvailable - 1 });
    await seatRepo.addBooking(slotId, userId);

    return { ok: true };
  });
}
