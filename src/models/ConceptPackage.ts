import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    concept: { type: Schema.Types.ObjectId, ref: 'Concept', required: true, index: true },
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 1000 },
    durationMinutes: { type: Number, required: true, min: 30, max: 600 },
    maxPeople: { type: Number, required: true, min: 1, max: 100 },
    retouchQuota: { type: Number, required: true, min: 1, max: 500 },
    extraPhotoPrice: { type: Number, required: true, min: 1 },
    costumeTypes: [{ type: Schema.Types.ObjectId, ref: 'CostumeType' }],
    costumeCount: { type: Number, default: 0, min: 0, max: 100 },
    active: { type: Boolean, default: true },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export default model('ConceptPackage', schema);
