import mongoose, { Document, Schema } from 'mongoose';

export interface ICostume extends Document {
  name: string;
  description?: string;
  gender: 'male' | 'female' | 'unisex';
  type?: mongoose.Types.ObjectId;
  itemKind: 'clothing' | 'accessory';
  isRentalItem: boolean;
  rentalPrice: number;
  rentalDailyPrice?: number | null;
  inventory: Array<{
    size: string;
    quantity: number;
    condition: 'good' | 'repair' | 'damaged' | 'retired';
  }>;
}

const inventorySchema = new Schema(
  {
    size: {
      type: String,
      required: true,
      enum: [
        'XS',
        'S',
        'M',
        'L',
        'XL',
        'XXL',
        'XXXL',
        'FREE',
        '36',
        '37',
        '38',
        '39',
        '40',
        '41',
        '42',
        '43',
        '44',
        '45',
      ],
    },
    quantity: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    condition: {
      type: String,
      enum: ['good', 'repair', 'damaged', 'retired'],
      default: 'good',
      required: true,
    },
  },
  { _id: false },
);

const costumeSchema = new Schema<ICostume>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    gender: {
      type: String,
      enum: ['male', 'female', 'unisex'],
      default: 'unisex',
      required: true,
    },
    type: { type: Schema.Types.ObjectId, ref: 'CostumeType', default: null },
    itemKind: {
      type: String,
      enum: ['clothing', 'accessory'],
      default: 'clothing',
      required: true,
    },
    // Existing costumes remain internal to schedules until an admin opts them into rental.
    isRentalItem: { type: Boolean, default: false, required: true },
    rentalPrice: {
      type: Number,
      min: 0,
      validate: Number.isSafeInteger,
      default: 0,
      required: true,
    },
    // Separate daily pricing; missing values must not reinterpret existing flat prices.
    rentalDailyPrice: {
      type: Number,
      default: null,
      validate: {
        validator: (value: number | null) =>
          value === null || (Number.isSafeInteger(value) && value > 0),
        message: 'Giá thuê/ngày phải là số nguyên dương hoặc để trống',
      },
    },
    inventory: { type: [inventorySchema], default: [] },
  },
  { timestamps: true },
);

export default mongoose.model<ICostume>('Costume', costumeSchema);
