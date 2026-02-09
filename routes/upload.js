const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const Job = require('../models/Job');
const { auditLog } = require('../db/postgres');
const { auth } = require('../middleware/auth');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const id = uuid();
    const ext = path.extname(file.originalname) || '.csv';
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({ storage });

router.post('/upload', auth, upload.single('file'), async (req, res, next) => {
  const jobId = uuid();
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = file.path;
    const mode = file.size > 50 * 1024 * 1024 ? 'large' : 'normal'; // 50MB threshold

    await Job.create({
      _id: jobId,
      status: 'starting',
      mode,
      file_name: file.originalname,
      file_path: filePath,
      user_id: req.user.id, // ownership from authenticated user
    });

    await auditLog(jobId, 'JOB_CREATED', { user_id: req.user.id });
    await auditLog(jobId, 'FILE_UPLOADED', {
      fileName: file.originalname,
      size: file.size,
      mode,
    });

    // Frontend expects { job_id } — matches Python backend's upload response
    res.json({ job_id: jobId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
