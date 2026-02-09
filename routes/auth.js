const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const User = require('../models/User');
const { auth } = require('../middleware/auth');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

/** Shared cookie options — httpOnly, strict sameSite, secure in production. */
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days (matches default JWT_EXPIRES_IN)
  path: '/',
};

/**
 * Issue a JWT with { userId, role } and set it as an httpOnly cookie.
 */
function issueToken(res, user) {
  const token = jwt.sign(
    { userId: user._id, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  res.cookie('token', token, COOKIE_OPTIONS);
  return token;
}


// ---- POST /api/register ----
// Creates a user with role "user" only. Admins cannot be created here.
router.post('/register', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const user = new User({
      _id: uuid(),
      email,
      password_hash: password, // pre-save hook hashes it
      role: 'user',            // hard-coded — no admin via register
    });
    await user.save();

    issueToken(res, user);

    res.status(201).json({
      user: { id: user._id, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});


// ---- POST /api/login ----
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await user.comparePassword(password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    issueToken(res, user);

    res.json({
      user: { id: user._id, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});


// ---- POST /api/logout ----
router.post('/logout', (_req, res) => {
  res.clearCookie('token', { path: '/' });
  res.json({ message: 'Logged out' });
});


// ---- GET /api/me ----
// Returns the current authenticated user's info.
router.get('/me', auth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password_hash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: { id: user._id, email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
});


module.exports = router;
