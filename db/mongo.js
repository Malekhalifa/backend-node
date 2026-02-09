const mongoose = require('mongoose');

async function connectWithRetry(retries = 5, delayMs = 2000) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      await mongoose.connect(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      console.log('Mongo connected');
      return;
    } catch (err) {
      attempt += 1;
      console.error(`Mongo connect failed (${attempt}/${retries})`, err.message);
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { connectWithRetry, mongoose };

