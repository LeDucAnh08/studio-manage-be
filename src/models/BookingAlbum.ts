import mongoose, { Schema } from 'mongoose';
const folder = new Schema({ id: String, resourceKey: String, name: String }, { _id: false });
const schema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true },
    title: { type: String, required: true, maxlength: 160 },
    publicId: { type: String, required: true, unique: true },
    tokenHash: { type: String, select: false },
    shared: { type: Boolean, default: false },
    version: { type: Number, default: 0 },
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
export default mongoose.model('BookingAlbum', schema);
