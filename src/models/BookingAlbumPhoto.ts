import { Schema } from 'mongoose';
import Photo from './Photo';
const schema = new Schema(
  {
    deliveryVersion: { type: Number, required: true, default: 0 },
    drive: { type: Schema.Types.Mixed, required: true },
    order: { type: Number, required: true },
    available: { type: Boolean, default: true },
    selected: { type: Boolean, default: false },
    note: { type: String, maxlength: 2000, default: '' },
  },
  { timestamps: true },
);
export default Photo.discriminator('BookingAlbumPhoto', schema, 'yearbook_drive');
