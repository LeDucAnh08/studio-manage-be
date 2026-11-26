import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IClass extends Document {
  className: string;
  school?: string;
  contactName: string;
  contactPhone: string;
  contactAddress: string;
  total: number;
  totalMale: number;
  totalFemale: number;
  notes?: string;
  createdBy?: Types.ObjectId;
  publicAccessToken?: string;
}

const classSchema = new Schema<IClass>(
  {
    className: { type: String, required: true, trim: true },
    school: { type: String, trim: true },
    contactName: { type: String, required: true, trim: true },
    contactPhone: { type: String, required: true, trim: true },
    contactAddress: { type: String, required: true, trim: true },
    total: { type: Number, required: true, default: 0 },
    totalMale: { type: Number, required: true, default: 0 },
    totalFemale: { type: Number, required: true, default: 0 },
    notes: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    publicAccessToken: { type: String, select: false, index: true },
  },
  { timestamps: true, collection: 'classes' },
);

classSchema.index({ className: 'text', school: 'text' });
classSchema.index({ createdBy: 1, createdAt: -1 });

export default mongoose.model<IClass>('Class', classSchema);
