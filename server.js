require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { connectWithRetry } = require('./db/mongo');
const { pool } = require('./db/postgres');

const authRoutes = require('./routes/auth');
const uploadRoutes = require('./routes/upload');
const analysisRoutes = require('./routes/analysis');
const cleaningRoutes = require('./routes/cleaning');

const app = express();

app.use(
  cors({
    origin: 'http://localhost:3000',
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Auth routes (register, login, logout, me) — no auth middleware needed on these
app.use('/api', authRoutes);

// Protected routes — auth middleware is applied inside each router
app.use('/api', uploadRoutes);
app.use('/api', analysisRoutes);
app.use('/api', cleaningRoutes);

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res
    .status(500)
    .json({ error: 'Internal server error', details: err.message });
});

const PORT = process.env.PORT || 3001;

(async () => {
  await connectWithRetry();
  app.listen(PORT, () => {
    console.log(`Node backend listening on http://localhost:${PORT}`);
  });
})();
