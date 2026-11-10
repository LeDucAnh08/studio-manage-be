import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    mode: { type: String, enum: ['sandbox', 'live'], required: true },
    providerTransactionId: { type: String, required: true },
    // Reference also prevents crediting the same bank transfer through multiple webhook IDs.
    bankReference: String,
    gateway: { type: String, required: true },
    accountNumber: { type: String, required: true },
    content: { type: String, required: true },
    code: String,
    amount: { type: Number, required: true, min: 1 },
    direction: { type: String, enum: ['in', 'out'], required: true },
    transactionDate: { type: Date, required: true },
    booking: { type: Schema.Types.ObjectId, ref: 'Booking' },
    workflowPayment: Schema.Types.ObjectId,
    conceptOrder: { type: Schema.Types.ObjectId, ref: 'ConceptOrder', index: true },
    conceptPayment: Schema.Types.ObjectId,
    rentalOrder: { type: Schema.Types.ObjectId, ref: 'RentalOrder' },
    rentalPayment: Schema.Types.ObjectId,
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolutionNote: String,
    resolvedAt: Date,
    status: { type: String, enum: ['pending', 'applied', 'review', 'ignored'], required: true },
    reason: String,
    hasConflict: { type: Boolean, default: false },
    conflicts: [
      {
        _id: false,
        payloadHash: String,
        providerTransactionId: String,
        bankReference: String,
        code: String,
        direction: String,
        gateway: String,
        accountNumber: String,
        content: String,
        amount: Number,
        transactionDate: Date,
      },
    ],
    payloadHash: { type: String, required: true },
  },
  { timestamps: true },
);
schema.index({ mode: 1, providerTransactionId: 1 }, { unique: true });
schema.index(
  { mode: 1, gateway: 1, accountNumber: 1, bankReference: 1 },
  { unique: true, partialFilterExpression: { bankReference: { $type: 'string' } } },
);
schema.index({ status: 1, createdAt: -1 });
export default model('SePayReceipt', schema);
