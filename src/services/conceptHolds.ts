import { ClientSession } from 'mongoose';
import ConceptOrder from '../models/ConceptOrder';

export const activeConceptHoldFilter = (now = new Date()) => ({
  status: 'awaiting_deposit',
  'reservation.status': 'held',
  'reservation.expiresAt': { $gt: now },
});
export async function conceptCostumeHolds(ids: string[], session?: ClientSession) {
  const rows = await ConceptOrder.find({
    ...activeConceptHoldFilter(),
    'costumes.costumeId': { $in: ids },
  })
    .select('costumes startAt endAt')
    .session(session || null)
    .lean();
  return rows.map((row) => ({
    conceptOrderId: String(row._id),
    status: 'confirmed',
    quote: { lines: row.costumes, receiveDate: row.startAt, returnDate: row.endAt },
  }));
}
