import mongoose, { Schema } from 'mongoose';
const schema = new Schema(
  {
    album: { type: Schema.Types.ObjectId, ref: 'BookingAlbum', required: true, index: true },
    deliveryVersion: { type: Number, required: true, default: 0 },
    drive: { type: Schema.Types.Mixed, required: true },
    order: { type: Number, required: true },
    available: { type: Boolean, default: true },
    selected: { type: Boolean, default: false },
    note: { type: String, maxlength: 2000, default: '' },
  },
  { timestamps: true },
);
schema.index({ album: 1, deliveryVersion: 1, 'drive.id': 1 }, { unique: true });
export default mongoose.model('BookingAlbumPhoto', schema);
