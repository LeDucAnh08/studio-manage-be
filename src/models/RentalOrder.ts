import mongoose, { Schema } from 'mongoose';

const line = new Schema(
  {
    costumeId: { type: Schema.Types.ObjectId, ref: 'Costume', required: true },
    name: { type: String, required: true },
    size: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
  },
  { _id: false },
);
const quote = new Schema(
  {
    version: Number,
    lines: [line],
    receiveDate: Date,
    returnDate: Date,
    fee: Number,
    deposit: Number,
    terms: [String],
    proposedAt: Date,
    acceptedAt: Date,
  },
  { _id: false },
);
const proposal = new Schema({
  kind: { type: String, enum: ['extend', 'cancel'] },
  status: { type: String, enum: ['requested', 'proposed', 'applied', 'declined'] },
  note: String,
  returnDate: Date,
  finalFee: Number,
  terms: [String],
  at: Date,
  acceptedAt: Date,
});
const schema = new Schema(
  {
    client: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    version: { type: Number, default: 0 },
    creationKey: { type: String, required: true },
    creationFingerprint: { type: String, required: true },
    contactName: String,
    phone: String,
    note: String,
    requestedLines: [line],
    requestedReceiveDate: Date,
    requestedReturnDate: Date,
    status: {
      type: String,
      default: 'requested',
      enum: [
        'requested',
        'quoting',
        'awaiting_deposit',
        'ready_to_confirm',
        'confirmed',
        'checked_out',
        'returned',
        'completed',
        'cancelled',
        'rejected',
      ],
      index: true,
    },
    quote,
    quoteHistory: [quote],
    payments: [
      {
        kind: { type: String, enum: ['deposit', 'balance', 'refund'] },
        amount: Number,
        method: String,
        reference: String,
        at: Date,
        actor: Schema.Types.ObjectId,
        transaction: { type: Schema.Types.ObjectId, ref: 'Transaction' },
      },
    ],
    checkedOutAt: Date,
    returnedAt: Date,
    returns: [
      {
        costumeId: Schema.Types.ObjectId,
        size: String,
        good: Number,
        damaged: Number,
        lost: Number,
      },
    ],
    settlement: {
      version: Number,
      charges: [{ label: String, amount: Number }],
      total: Number,
      note: String,
      proposedAt: Date,
      acceptedAt: Date,
    },
    settlementHistory: [
      {
        version: Number,
        charges: [{ label: String, amount: Number }],
        total: Number,
        note: String,
        proposedAt: Date,
        acceptedAt: Date,
      },
    ],
    change: proposal,
    changeHistory: [proposal],
    events: [{ action: String, actor: Schema.Types.ObjectId, at: Date, message: String }],
    commands: [{ key: String, actor: Schema.Types.ObjectId, fingerprint: String, action: String }],
    feedback: { rating: Number, comment: String, at: Date },
  },
  { timestamps: true },
);
schema.index({ client: 1, creationKey: 1 }, { unique: true });
export default mongoose.model('RentalOrder', schema);
