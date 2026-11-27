import mongoose from 'mongoose';

export async function assertConceptDetailStore() {
  const legacy = await mongoose.connection
    .collection('conceptpackages')
    .findOne({}, { projection: { _id: 1 } });
  if (legacy)
    throw new Error(
      'Concept detail migration required: run migrate:concept-details -- --apply before starting API/worker',
    );
}
