import { Schema } from 'mongoose';
import Photo from './Photo';

const schema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
    originalPhotoId: { type: Schema.Types.ObjectId, ref: 'Photo' },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    uploadKey: { type: String, required: true, select: false },
    sha256: { type: String, required: true, select: false },
    name: { type: String, required: true, maxlength: 160 },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    bytes: { type: Number, required: true },
    publishedVersions: { type: [Number], default: [] },
    deletedAt: Date,
  },
  { timestamps: true },
);
schema.index({ booking: 1, uploadKey: 1 }, { unique: true });
export default Photo.discriminator('BookingDeliveryPhoto', schema, 'yearbook_upload');
