const express = require('express');
const fs = require('fs');
const Job = require('../models/Job');
const CleaningResult = require('../models/CleaningResult');
const { runCleaning } = require('../services/cleaningService');
const { auditLog } = require('../db/postgres');
const { auth } = require('../middleware/auth');

const router = express.Router();

/**
 * Find a job by ID and verify ownership.
 * Admins can access any job; regular users can only access their own.
 */
async function findOwnedJob(jobId, user) {
  const job = await Job.findById(jobId);
  if (!job) return null;
  if (user.role === 'admin') return job;
  if (job.user_id !== user.id) return null;
  return job;
}

router.post('/clean/:jobId', auth, async (req, res, next) => {
  const { jobId } = req.params;
  try {
    const job = await findOwnedJob(jobId, req.user);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Extract cleaning options from request body
    const { mode, rules } = req.body || {};
    const cleaningOptions = {
      mode: mode || 'auto',
      rules: rules || {},
    };

    // Fire and forget — cleaning runs in background
    runCleaning(jobId, cleaningOptions).catch((err) =>
      console.error('Cleaning error', err)
    );

    await auditLog(jobId, 'CLEANING_ENQUEUED', { mode: cleaningOptions.mode });
    res.json({ job_id: jobId, status: 'cleaning_started' });
  } catch (err) {
    next(err);
  }
});

router.get('/cleaned/:jobId', auth, async (req, res, next) => {
  const { jobId } = req.params;
  try {
    const job = await findOwnedJob(jobId, req.user);
    if (!job || !job.cleaned_file_path)
      return res.status(404).json({ error: 'Cleaned file not found' });

    if (!fs.existsSync(job.cleaned_file_path)) {
      return res.status(404).json({ error: 'File missing on disk' });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${job._id}-cleaned.csv"`
    );
    fs.createReadStream(job.cleaned_file_path).pipe(res);
  } catch (err) {
    next(err);
  }
});

router.get('/cleaning-result/:jobId', auth, async (req, res, next) => {
  const { jobId } = req.params;
  try {
    const job = await findOwnedJob(jobId, req.user);
    if (!job) return res.status(404).json({ error: 'Not found' });

    const result = await CleaningResult.findOne({ job_id: jobId });
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---- GET /cleaning-result/:jobId/export ----
// Returns a structured cleaning report for download.
router.get('/cleaning-result/:jobId/export', auth, async (req, res, next) => {
  const { jobId } = req.params;
  try {
    const job = await findOwnedJob(jobId, req.user);
    if (!job) return res.status(404).json({ error: 'Not found' });

    const result = await CleaningResult.findOne({ job_id: jobId }).lean();
    if (!result) return res.status(404).json({ error: 'No cleaning result found' });

    const summary = result.summary || {};
    const rulesApplied = result.rules_applied || [];

    const report = {
      meta: {
        job_id: jobId,
        file_name: job.file_name || null,
        file_path: job.file_path || null,
        cleaned_file_path: job.cleaned_file_path || null,
        cleaning_mode: result.mode || 'auto',
        cleaned_at: result.updated_at || result.created_at || null,
        version: '1.0',
      },
      summary: {
        rows_before: summary.rows_before ?? null,
        rows_after: summary.rows_after ?? null,
        rows_removed: summary.rows_removed ?? null,
        removal_rate: summary.rows_before
          ? +(summary.rows_removed / summary.rows_before).toFixed(4)
          : null,
      },
      rules_applied: rulesApplied.map((r) => ({
        rule: r.rule || null,
        description: r.description || null,
        rows_removed: r.rows_removed ?? null,
        columns: r.columns || null,
      })),
      rules_summary: {
        total_rules_applied: rulesApplied.length,
        rules_list: rulesApplied.map((r) => r.rule).filter(Boolean),
      },
    };

    res.json(report);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
