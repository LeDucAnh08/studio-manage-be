import mongoose, { Schema } from 'mongoose';

// Service discriminators share storage while keeping their workflow and query scope.
const schema = new Schema(
  {
    title: { type: String, required: true, maxlength: 160 },
    version: { type: Number, default: 0 },
    booking: { type: Schema.Types.ObjectId, ref: 'Booking' },
    order: { type: Schema.Types.ObjectId, ref: 'ConceptOrder' },
  },
  { timestamps: true, collection: 'albums', discriminatorKey: 'service' },
);
schema.pre('validate', function () {
  const service = this.get('service');
  if (
    !['yearbook', 'concept'].includes(service) ||
    (service === 'yearbook' ? !this.booking || !!this.order : !this.order || !!this.booking)
  )
    this.invalidate('service', 'Album phải thuộc đúng một đơn kỉ yếu hoặc concept.');
});
schema.index({ booking: 1 }, { unique: true, partialFilterExpression: { service: 'yearbook' } });
schema.index({ order: 1 }, { unique: true, partialFilterExpression: { service: 'concept' } });
export default mongoose.model('Album', schema);
