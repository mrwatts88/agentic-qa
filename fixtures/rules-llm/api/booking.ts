/**
 * Booking a seat on a slot.
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
