const { mongoose } = require('../db/mongo');
const { Schema } = mongoose;

const JobSchema = new Schema({
  _id: { type: String }, // UUID
  status: {
    type: String,
    enum: ['starting', 'running', 'completed', 'failed', 'cleaning', 'cleaned', 'unknown'],
    index: true,
  },
  mode: { type: String, enum: ['normal', 'large'], default: 'normal' },
  user_id: { type: String, ref: 'User', index: true },
  file_name: String, // original filename from upload
  file_path: String,
  cleaned_file_path: String,
  created_at: { type: Date, default: Date.now, index: true },
  updated_at: { type: Date, default: Date.now },
});

JobSchema.pre('save', function () {
  this.updated_at = new Date();
});

module.exports = mongoose.model('Job', JobSchema);

