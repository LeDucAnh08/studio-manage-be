import mongoose, { Schema } from 'mongoose';

const schema = new Schema({
  album: { type: Schema.Types.ObjectId, ref: 'BookingAlbum', required: true },
  round: { type: Number, required: true },
  driveId: { type: String, required: true },
  name: { type: String, required: true },
  note: { type: String, default: '' },
});
schema.index({ album: 1, round: 1, driveId: 1 }, { unique: true });
export default mongoose.model('BookingAlbumSelection', schema);
