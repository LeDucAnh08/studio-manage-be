import type { Document } from 'mongoose';
import mongoose from 'mongoose';

export interface ISeason extends Document {
  name: string;
  startDate: Date;
  endDate: Date;
}

const seasonSchema = new mongoose.Schema<ISeason>(
  {
    name: { type: String, required: true, unique: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
  },
  { timestamps: true },
);

// Compound index for resolveSeasonForDate queries (startDate <= date <= endDate)
seasonSchema.index({ startDate: 1, endDate: 1 });

export default mongoose.model<ISeason>('Season', seasonSchema);
