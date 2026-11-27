import { Schema } from 'mongoose';
import Photo from './Photo';

const schema = new Schema(
  {
    deliveryVersion: { type: Number, required: true }, // 0: selection; >0: immutable delivery.
    drive: { type: Schema.Types.Mixed, required: true },
    available: { type: Boolean, default: true },
    selected: { type: Boolean, default: false },
    note: { type: String, default: '', maxlength: 2000 },
    order: { type: Number, required: true },
  },
  { timestamps: true },
);
export default Photo.discriminator('ConceptPhoto', schema, 'concept_drive');
