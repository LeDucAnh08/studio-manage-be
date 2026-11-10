import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    photographer: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    concepts: [{ type: Schema.Types.ObjectId, ref: 'Concept' }],
    bio: { type: String, default: '', maxlength: 2000 },
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
