import mongoose, { Document, Schema, Types } from 'mongoose';
import type { PackageDetails } from '../types/packageContent';

export interface IPackage extends Document {
  name: string;
  pricePerMember: number;
  depositPercent?: number;
  depositHoldHours?: number;
  duration?: 'full_day' | 'half_day' | 'two_thirds_day';
  costumes?: Types.ObjectId[];
  crewRatio?: string;
  editingScope?: 'full' | 'partial';
  deliveryDays?: number;
  studentsPerCrew?: number;
  description?: string;
  isPopular?: boolean;
  details?: PackageDetails;
  detailsVersion?: number;
}

const stepSchema = new Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: '' },
  },
  { _id: false },
);

const detailsSchema = new Schema<PackageDetails>(
  {
    audience: { type: String, default: '' },
    deliverables: { type: String, default: '' },
    shootScope: { type: String, default: '' },
    pricingConditions: { type: String, default: '' },
    benefits: [String],
    exclusions: [String],
    itinerary: [new Schema({ time: String, title: String, description: String }, { _id: false })],
    process: [stepSchema],
    extraCosts: [
      new Schema({ name: String, priceLabel: String, condition: String }, { _id: false }),
    ],
    preparationNotes: { type: String, default: '' },
    depositPolicy: { type: String, default: '' },
    cancellationPolicy: { type: String, default: '' },
    priceNotes: { type: String, default: '' },
    gallery: [
      new Schema(
        {
          id: String,
          alt: String,
          caption: String,
          width: Number,
          height: Number,
        },
        { _id: false },
      ),
    ],
  },
  { _id: false },
);

const packageSchema = new Schema<IPackage>(
  {
    name: { type: String, required: true, trim: true },
    pricePerMember: { type: Number, required: true },
    depositPercent: { type: Number, default: 30, min: 1, max: 100, validate: Number.isSafeInteger },
    depositHoldHours: {
      type: Number,
      default: 24,
      min: 1,
      max: 168,
      validate: Number.isSafeInteger,
    },
    duration: { type: String, enum: ['full_day', 'half_day', 'two_thirds_day'] },
    costumes: [{ type: Schema.Types.ObjectId, ref: 'CostumeType' }],
    crewRatio: { type: String, trim: true },
    editingScope: { type: String, enum: ['full', 'partial'], default: 'full' },
    deliveryDays: { type: Number },
    studentsPerCrew: { type: Number },
    description: { type: String, trim: true },
    isPopular: { type: Boolean, default: false },
    details: { type: detailsSchema, default: undefined },
    detailsVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export default mongoose.model<IPackage>('Package', packageSchema);
