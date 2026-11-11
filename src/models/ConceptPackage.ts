import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    concept: { type: Schema.Types.ObjectId, ref: 'Concept', required: true, index: true },
    name: { type: String, required: true },
    imageUrl: { type: String, default: '' },
    introduction: { type: String, default: '', maxlength: 1000 },
    studioSupport: [
      {
        _id: false,
        title: { type: String, maxlength: 120 },
        description: { type: String, maxlength: 500 },
      },
    ],
    delivery: {
      timeline: { type: String, default: '', maxlength: 1000 },
      format: { type: String, default: '', maxlength: 1000 },
      originals: { type: String, default: '', maxlength: 1000 },
    },
    showcase: {
      title: { type: String, default: '', maxlength: 120 },
      description: { type: String, default: '', maxlength: 1000 },
      images: [
        {
          _id: false,
          url: { type: String, required: true },
          caption: { type: String, default: '', maxlength: 200 },
        },
      ],
    },
    decor: {
      backdrop: { type: String, default: '', maxlength: 1000 },
      props: { type: String, default: '', maxlength: 1000 },
      layout: { type: String, default: '', maxlength: 1000 },
      included: { type: String, default: '', maxlength: 1000 },
    },
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
