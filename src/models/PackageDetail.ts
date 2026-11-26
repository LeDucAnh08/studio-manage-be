import mongoose, { Document, Schema, Types } from 'mongoose';
import type { PackageDetails } from '../types/packageContent';

export interface IPackageDetail extends Document, PackageDetails {
  package: Types.ObjectId;
  version: number;
}

export const PACKAGE_DETAIL_FIELDS = [
  'audience',
  'deliverables',
  'shootScope',
  'pricingConditions',
  'benefits',
  'exclusions',
  'itinerary',
  'process',
  'extraCosts',
  'preparationNotes',
  'depositPolicy',
  'cancellationPolicy',
  'priceNotes',
  'gallery',
] as const;

const schema = new Schema<IPackageDetail>(
  {
    package: { type: Schema.Types.ObjectId, ref: 'Package', required: true, unique: true },
    version: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
    audience: { type: String, default: '' },
    deliverables: { type: String, default: '' },
    shootScope: { type: String, default: '' },
    pricingConditions: { type: String, default: '' },
    benefits: [String],
    exclusions: [String],
    itinerary: [new Schema({ time: String, title: String, description: String }, { _id: false })],
    process: [
      new Schema(
        { title: { type: String, required: true }, description: { type: String, default: '' } },
        { _id: false },
      ),
    ],
    extraCosts: [
      new Schema({ name: String, priceLabel: String, condition: String }, { _id: false }),
    ],
    preparationNotes: { type: String, default: '' },
    depositPolicy: { type: String, default: '' },
    cancellationPolicy: { type: String, default: '' },
    priceNotes: { type: String, default: '' },
    gallery: [
      new Schema(
        { id: String, alt: String, caption: String, width: Number, height: Number },
        { _id: false },
      ),
    ],
  },
  { timestamps: true, collection: 'package_details' },
);

export default mongoose.model<IPackageDetail>('PackageDetail', schema);
