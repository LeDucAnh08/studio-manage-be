import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    photographer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    note: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { timestamps: true },
);
schema.index({ photographer: 1, startAt: 1, endAt: 1 });

export default model('PhotographerUnavailability', schema);
