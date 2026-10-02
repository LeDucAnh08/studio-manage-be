import mongoose, { Document, Schema } from 'mongoose';

export interface IStudent extends Document {
  customer: mongoose.Types.ObjectId;
  name: string;
  gender: 'male' | 'female';
  height: number;
  weight: number;
  notes?: string;
  costumes: mongoose.Types.ObjectId[];
  costumeSizes?: Array<{ costume: mongoose.Types.ObjectId; size: string }>;
}

const studentSchema = new Schema<IStudent>(
  {
    customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    name: { type: String, required: true, trim: true },
    gender: { type: String, enum: ['male', 'female', 'other'] },
    height: { type: Number, min: 1 },
    weight: { type: Number, min: 1 },
    notes: { type: String },
    costumes: [{ type: Schema.Types.ObjectId, ref: 'Costume', default: [] }],
    costumeSizes: [
      {
        _id: false,
        costume: { type: Schema.Types.ObjectId, ref: 'Costume', required: true },
        size: { type: String, required: true },
      },
    ],
  },
  { timestamps: true },
);

studentSchema.index({ customer: 1 });
studentSchema.index({ name: 'text' });

export default mongoose.model<IStudent>('Student', studentSchema);
