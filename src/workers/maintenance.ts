import { expirePendingBookings } from '../services/bookingExpiry';
import { expireConceptOrders } from '../services/conceptBooking';
import { conceptEnabled } from '../services/conceptPolicy';
import { assertJobRuntime } from '../services/jobQueue';

export async function runMaintenance() {
  await assertJobRuntime();
  await expirePendingBookings(new Date());
  if (conceptEnabled()) await expireConceptOrders();
}
