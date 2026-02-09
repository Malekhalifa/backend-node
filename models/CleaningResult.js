const { mongoose } = require('../db/mongo');
const { Schema } = mongoose;

const CleaningSchema = new Schema({
  job_id: { type: String, ref: 'Job', unique: true, index: true },
  mode: { type: String, enum: ['auto', 'manual'], default: 'auto' },
  rules_applied: [Schema.Types.Mixed],
  summary: Schema.Types.Mixed,
  created_at: { type: Date, default: Date.now, index: true },
  updated_at: { type: Date, default: Date.now },
});

CleaningSchema.pre('save', function () {
  this.updated_at = new Date();
});

module.exports = mongoose.model('CleaningResult', CleaningSchema);

