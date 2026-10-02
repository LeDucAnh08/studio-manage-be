import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ISchedule extends Document {
  customer: Types.ObjectId;
  package?: Types.ObjectId;
  costumes: Types.ObjectId[];
  shootDate: Date;
  startTime?: string;
  endTime?: string;
  location?: string;
  leadPhotographer?: Types.ObjectId;
  supportPhotographers: Types.ObjectId[];
  bookedBy?: Types.ObjectId;
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled';
  notes?: string;
  season?: Types.ObjectId | null;
  contractUrl?: string;
  driveFolderUrl?: string;
  driveFolderId?: string;
  workflowBooking?: Types.ObjectId;
  costumeReservations?: Array<{
    costume: Types.ObjectId;
    size: string;
    quantity: number;
    receiveDate: Date;
    returnDate: Date;
  }>;
}

const scheduleSchema = new Schema<ISchedule>(
  {
    customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    package: { type: Schema.Types.ObjectId, ref: 'Package', default: null },
    costumes: [{ type: Schema.Types.ObjectId, ref: 'Costume', default: [] }],
    shootDate: { type: Date, required: true },
    startTime: { type: String, trim: true },
    endTime: { type: String, trim: true },
    location: { type: String, trim: true },
    leadPhotographer: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    supportPhotographers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    bookedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'completed', 'cancelled'],
      default: 'pending',
    },
    notes: { type: String },
    season: { type: Schema.Types.ObjectId, ref: 'Season', default: null },
    contractUrl: { type: String },
    driveFolderUrl: { type: String },
    driveFolderId: { type: String },
    workflowBooking: { type: Schema.Types.ObjectId, ref: 'Booking' },
    costumeReservations: [
      {
        _id: false,
        costume: { type: Schema.Types.ObjectId, ref: 'Costume', required: true },
        size: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1 },
        receiveDate: { type: Date, required: true },
        returnDate: { type: Date, required: true },
      },
    ],
  },
  { timestamps: true },
);

scheduleSchema.index({ shootDate: 1 });
scheduleSchema.index({ customer: 1 });
scheduleSchema.index({ status: 1 });
scheduleSchema.index({ season: 1 });
scheduleSchema.index({ season: 1, shootDate: -1 });
scheduleSchema.index({ leadPhotographer: 1, shootDate: 1 });
scheduleSchema.index({ supportPhotographers: 1, shootDate: 1 });
scheduleSchema.index({ workflowBooking: 1 }, { unique: true, sparse: true });
scheduleSchema.index({ costumes: 1, shootDate: 1, status: 1 });

export default mongoose.model<ISchedule>('Schedule', scheduleSchema);
