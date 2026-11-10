import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    name: { type: String, required: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 4000 },
    coverUrl: { type: String, default: '' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export default model('Concept', schema);
