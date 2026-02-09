const { mongoose } = require('../db/mongo');
const { Schema } = mongoose;

/**
 * Stores the FULL analysis result returned by the Python worker.
 * `result` contains: { cleaned_data, quality_report, meta }
 * This is returned as-is to the frontend (minus Mongo internals).
 */
const AnalysisSchema = new Schema({
  job_id: { type: String, ref: 'Job', unique: true, index: true },
  // Full Python result: { cleaned_data, quality_report, meta }
  result: Schema.Types.Mixed,
  analysis_type: { type: String, enum: ['in-memory', 'streaming'] },
  created_at: { type: Date, default: Date.now, index: true },
  updated_at: { type: Date, default: Date.now },
});

AnalysisSchema.pre('save', function () {
  this.updated_at = new Date();
});

module.exports = mongoose.model('AnalysisResult', AnalysisSchema);
