import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    album: { type: Schema.Types.ObjectId, ref: 'ConceptAlbum', required: true },
    version: { type: Number, required: true }, // 0: color-corrected selection; >0: immutable delivery.
    drive: { type: Schema.Types.Mixed, required: true },
    available: { type: Boolean, default: true },
    selected: { type: Boolean, default: false },
    note: { type: String, default: '', maxlength: 2000 },
    order: { type: Number, required: true },
  },
  { timestamps: true },
);
schema.index({ album: 1, version: 1, 'drive.id': 1 }, { unique: true });
export default model('ConceptPhoto', schema);
