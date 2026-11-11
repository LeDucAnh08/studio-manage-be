import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    name: { type: String, required: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 4000 },
    coverUrl: { type: String, default: '' },
    story: { type: String, default: '', maxlength: 6000 },
    styleSummary: { type: String, default: '', maxlength: 300 },
    audience: { type: String, default: '', maxlength: 1000 },
    setting: { type: String, default: '', maxlength: 1000 },
    wardrobeGuidance: { type: String, default: '', maxlength: 1000 },
    preparation: { type: String, default: '', maxlength: 2000 },
    gallery: [
      {
        url: { type: String, required: true },
        caption: { type: String, default: '', maxlength: 200 },
      },
    ],
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export default model('Concept', schema);
