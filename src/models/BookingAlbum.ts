import { Schema } from 'mongoose';
import Album from './Album';
const folder = new Schema({ id: String, resourceKey: String, name: String }, { _id: false });
const schema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    publicId: { type: String, required: true },
    tokenHash: { type: String, select: false },
    shared: { type: Boolean, default: false },
    status: { type: String, enum: ['draft', 'open', 'closed'], default: 'draft' },
    limit: { type: Number, default: 0, min: 0, max: 10000 },
    coverId: String,
    folders: { type: [folder], default: [] },
    skipped: { type: [String], default: [] },
    finalizedAt: Date,
    selectionHistory: { type: [Schema.Types.Mixed], default: [] },
    requests: { type: [{ key: String, fingerprint: String }], default: [], select: false },
  },
  { timestamps: true },
);
schema.index({ publicId: 1 }, { unique: true, partialFilterExpression: { service: 'yearbook' } });
export default Album.discriminator('BookingAlbum', schema, 'yearbook');
