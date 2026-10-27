import type { ClientSession } from 'mongoose';
import Booking from '../models/Booking';

export const activeBookingHoldFilter = (now = new Date()) => ({
  status: { $in: ['pending', 'approved'] },
  $or: [
    { 'costumeHold.status': 'temporary', 'costumeHold.expiresAt': { $gt: now } },
    { 'costumeHold.status': 'approved' },
  ],
});

// Adapt booking holds to the existing internal reservation shape so every stock
// calculation (rentals, schedules and inventory edits) uses the same quantities.
export const loadBookingCostumeHolds = async (
  costumeIds: string[],
  session?: ClientSession,
  excludeBooking?: string,
): Promise<any[]> => {
  if (!costumeIds.length) return [];
  const query = Booking.find({
    ...activeBookingHoldFilter(),
    'costumeSelections.costumeId': { $in: costumeIds },
    ...(excludeBooking ? { _id: { $ne: excludeBooking } } : {}),
  }).select('costumeSelections costumeHold');
  if (session) query.session(session);
  const bookings = await query.lean();
  return bookings.map((booking) => ({
    bookingId: String(booking._id),
    status: 'confirmed',
    quote: {
      lines: booking.costumeSelections,
      receiveDate: booking.costumeHold!.receiveDate,
      returnDate: booking.costumeHold!.returnDate,
    },
  }));
};

export const bookingCostumeDto = (booking: any, now = new Date()) => ({
  costumeSelections: booking.costumeSelections ?? [],
  costumeHold: booking.costumeHold
    ? {
        ...(typeof booking.costumeHold.toObject === 'function'
          ? booking.costumeHold.toObject()
          : booking.costumeHold),
        status:
          booking.costumeHold.status === 'temporary' &&
          new Date(booking.costumeHold.expiresAt) <= now
            ? 'expired'
            : booking.costumeHold.status,
      }
    : null,
});
