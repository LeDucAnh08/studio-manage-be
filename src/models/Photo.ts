import mongoose, { Schema } from 'mongoose';

const schema = new Schema(
  {
    album: { type: Schema.Types.ObjectId, ref: 'Album', required: true, index: true },
  },
  { timestamps: true, collection: 'photos', discriminatorKey: 'kind' },
);
schema.index(
  { album: 1, deliveryVersion: 1, 'drive.id': 1 },
  { unique: true, partialFilterExpression: { 'drive.id': { $exists: true } } },
);
export default mongoose.model('Photo', schema);
