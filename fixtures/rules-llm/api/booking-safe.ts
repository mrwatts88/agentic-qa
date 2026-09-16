/**
 * Booking a seat on a slot.
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
