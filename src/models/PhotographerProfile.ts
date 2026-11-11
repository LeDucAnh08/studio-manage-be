import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    photographer: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    concepts: [{ type: Schema.Types.ObjectId, ref: 'Concept' }],
    bio: { type: String, default: '', maxlength: 2000 },
    portraitUrl: { type: String, default: '' },
    coverUrl: { type: String, default: '' },
    title: { type: String, default: '', maxlength: 120 },
    tagline: { type: String, default: '', maxlength: 180 },
    story: { type: String, default: '', maxlength: 4000 },
    specialty: { type: String, default: '', maxlength: 300 },
    style: { type: String, default: '', maxlength: 600 },
    guidance: { type: String, default: '', maxlength: 600 },
    philosophy: { type: String, default: '', maxlength: 1500 },
    approach: [
      {
        _id: false,
        title: { type: String, maxlength: 120 },
        description: { type: String, maxlength: 600 },
      },
    ],
    audience: [
      {
        _id: false,
        title: { type: String, maxlength: 120 },
        description: { type: String, maxlength: 600 },
      },
    ],
    milestones: [
      {
        _id: false,
        title: { type: String, maxlength: 120 },
        description: { type: String, maxlength: 600 },
      },
    ],
    published: { type: Boolean, default: false },
    portfolio: [
      {
        concept: { type: Schema.Types.ObjectId, ref: 'Concept', required: true },
        url: { type: String, required: true },
        caption: { type: String, maxlength: 200 },
        permitted: { type: Boolean, required: true },
      },
    ],
  },
  { timestamps: true },
);
export default model('PhotographerProfile', schema);
