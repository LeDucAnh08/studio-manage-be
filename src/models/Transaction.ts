import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ITransaction extends Document {
  customer?: Types.ObjectId | null;
  type: 'income' | 'expense';
  amount: number;
  categoryId: Types.ObjectId;
  description?: string;
  date: Date;
  createdBy?: Types.ObjectId;
  accountantRefunded: boolean;
  season?: Types.ObjectId | null;
  workflowBooking?: Types.ObjectId;
  workflowPayment?: Types.ObjectId;
  rentalOrder?: Types.ObjectId;
  rentalPayment?: Types.ObjectId;
}

const transactionSchema = new Schema<ITransaction>(
  {
    customer: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    type: { type: String, enum: ['income', 'expense'], required: true },
    amount: { type: Number, required: true, min: 0 },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    description: { type: String, trim: true },
    date: { type: Date, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    accountantRefunded: { type: Boolean, default: false },
    season: { type: Schema.Types.ObjectId, ref: 'Season', default: null },
    workflowBooking: { type: Schema.Types.ObjectId, ref: 'Booking', index: true },
    workflowPayment: { type: Schema.Types.ObjectId, ref: 'BookingWorkflow' },
    rentalOrder: { type: Schema.Types.ObjectId, ref: 'RentalOrder', index: true },
    rentalPayment: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

transactionSchema.index({ date: 1 });
transactionSchema.index({ customer: 1 });
transactionSchema.index({ type: 1 });
transactionSchema.index({ season: 1 });
transactionSchema.index({ createdBy: 1, date: 1 });
transactionSchema.index({ season: 1, date: 1 });
transactionSchema.index({ workflowBooking: 1, workflowPayment: 1 }, { unique: true, sparse: true });
transactionSchema.index({ rentalOrder: 1, rentalPayment: 1 }, { unique: true, sparse: true });

export default mongoose.model<ITransaction>('Transaction', transactionSchema);
