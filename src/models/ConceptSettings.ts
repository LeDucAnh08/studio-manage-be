import { Schema, model } from 'mongoose';
const schema = new Schema(
  {
    _id: { type: String, default: 'studio' },
    openMinutes: { type: Number, default: 540 },
    closeMinutes: { type: Number, default: 1140 },
    stepMinutes: { type: Number, default: 30 },
    bufferMinutes: { type: Number, default: 60 },
    horizonDays: { type: Number, default: 90 },
    closedWeekdays: { type: [Number], default: [] },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export default model('ConceptSettings', schema);
