const { mongoose } = require('../db/mongo');
const { Schema } = mongoose;
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 12;

const UserSchema = new Schema({
  _id: { type: String }, // UUID
  email: { type: String, required: true, unique: true, index: true },
  password_hash: { type: String, required: true },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
  },
  created_at: { type: Date, default: Date.now },
});

/**
 * Hash password before saving (only if password_hash was modified).
 * Callers must set password_hash to the PLAIN password; this hook replaces it
 * with the bcrypt hash. This keeps hashing logic in one place.
 */
UserSchema.pre('save', async function () {
  if (!this.isModified('password_hash')) return;
  this.password_hash = await bcrypt.hash(this.password_hash, SALT_ROUNDS);
});

/**
 * Compare a candidate password against the stored hash.
 */
UserSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password_hash);
};

module.exports = mongoose.model('User', UserSchema);
