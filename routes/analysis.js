/**
 * Analysis routes — Node is the API gateway.
 *
 * - Job status comes from MongoDB (Node owns job lifecycle).
 * - Analysis results come from MongoDB (stored after Python worker returns).
 * - Raw data + outlier enrichment are proxied to Python (Node does NOT parse CSVs).
 * - All routes require authentication; job ownership is enforced server-side.
 */

const express = require('express');
const fs = require('fs');
const Job = require('../models/Job');
const AnalysisResult = require('../models/AnalysisResult');
const CleaningResult = require('../models/CleaningResult');
const { runAnalysis } = require('../services/analysisService');
const { auditLog } = require('../db/postgres');
const { auth } = require('../middleware/auth');

const router = express.Router();

const PYTHON_URL = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';


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


// ---- POST /analyze/:jobId ----
// Starts analysis by delegating to Python worker (in-process async).
router.post('/analyze/:jobId', auth, async (req, res, next) => {
  const { jobId } = req.params;
  try {
    const job = await findOwnedJob(jobId, req.user);
    if (!job) return res.status(404).json({ detail: 'No uploaded file found for this job.' });

    // Fire and forget — analysis runs in background
    runAnalysis(jobId).catch((err) => console.error('Analysis error:', err.message));

    await auditLog(jobId, 'ANALYSIS_ENQUEUED', {});
    // Response shape matches what the frontend expects from Python backend
    res.json({ message: 'analysis started' });
  } catch (err) {
    next(err);
  }
});


// ---- GET /status/:jobId ----
// Returns { status } from Job document in MongoDB.
router.get('/status/:jobId', auth, async (req, res, next) => {
  const { jobId } = req.params;
  try {
    const job = await findOwnedJob(jobId, req.user);
    const status = job ? job.status : 'unknown';
    res.json({ status });
  } catch (err) {
    next(err);
  }
});


// ---- GET /results/:jobId ----
// Returns { cleaned_data, quality_report } — the exact shape the frontend reads.
router.get('/results/:jobId', auth, async (req, res, next) => {
  const { jobId } = req.params;
  try {
    const job = await findOwnedJob(jobId, req.user);
    if (!job) return res.status(404).json({ detail: 'Results not found' });

    const analysis = await AnalysisResult.findOne({ job_id: jobId }).lean();
    if (!analysis || !analysis.result) {
      return res.status(404).json({ detail: 'Results not found' });
    }

    // analysis.result is the full Python response: { cleaned_data, quality_report, meta }
    // The frontend expects { cleaned_data, quality_report } at top level
    const { cleaned_data, quality_report } = analysis.result;

    res.json({ cleaned_data, quality_report });
  } catch (err) {
    next(err);
  }
});


// ---- GET /results/:jobId/export ----
// Returns the full result with meta for report download.
router.get('/results/:jobId/export', auth, async (req, res, next) => {
  const { jobId } = req.params;
  try {
    const job = await findOwnedJob(jobId, req.user);
    if (!job) return res.status(404).json({ detail: 'Results not found' });

    const analysis = await AnalysisResult.findOne({ job_id: jobId }).lean();
    if (!analysis || !analysis.result) {
      return res.status(404).json({ detail: 'Results not found' });
    }

    const data = analysis.result;
    const meta = data.meta || {};
    const qr = data.quality_report || {};
    const cleaned = data.cleaned_data || {};

    // Build export report (same structure as Python's _build_export_report)
    const exportReport = {
      meta: {
        job_id: jobId,
        file_path: meta.file_path || null,
        file_size_bytes: meta.file_size_bytes || null,
        mode: meta.mode || 'normal',
        analysis_type: meta.analysis_type || 'in-memory',
        started_at: meta.started_at || null,
        completed_at: meta.completed_at || null,
        duration_ms: meta.duration_ms || null,
        version: '1.0',
      },
      dataset_summary: {
        rows: cleaned.rows || 0,
        columns: cleaned.columns || 0,
      },
      quality_overview: {
        missing_rate: qr.missing_rate ?? null,
        duplicate_rate: qr.duplicate_rate ?? null,
        error_rate: qr.outlier_rate ?? null,
      },
      column_analysis: qr.column_analysis || {},
      limitations: {
        approximate_metrics: false,
        skipped_checks: [],
      },
    };

    res.json(exportReport);
  } catch (err) {
    next(err);
  }
});


// ---- GET /raw/:jobId ----
// Proxies to Python worker — Node does NOT parse CSVs.
router.get('/raw/:jobId', auth, async (req, res, next) => {
  const { jobId } = req.params;
  try {
    const job = await findOwnedJob(jobId, req.user);
    if (!job || !job.file_path) {
      return res.status(404).json({ detail: 'No data found for this job.' });
    }

    const response = await fetch(`${PYTHON_URL}/internal/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: job.file_path }),
    });

    if (!response.ok) {
      return res.status(502).json({ detail: 'Python worker error' });
    }

    const data = await response.json();
    if (data.error) {
      return res.status(404).json({ detail: data.error });
    }

    res.json(data);
  } catch (err) {
    // If Python is down, return a clear error
    if (err.cause?.code === 'ECONNREFUSED') {
      return res.status(503).json({ detail: 'Python worker is not reachable' });
    }
    next(err);
  }
});


// ---- GET /raw_with_outliers/:jobId ----
// Proxies to Python worker for outlier-enriched raw data.
router.get('/raw_with_outliers/:jobId', auth, async (req, res, next) => {
  const { jobId } = req.params;
  try {
    const job = await findOwnedJob(jobId, req.user);
    if (!job || !job.file_path) {
      return res.status(404).json({ detail: 'No data found for this job.' });
    }

    const response = await fetch(`${PYTHON_URL}/internal/raw_with_outliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: job.file_path }),
    });

    if (!response.ok) {
      return res.status(502).json({ detail: 'Python worker error' });
    }

    const data = await response.json();
    if (data.error) {
      return res.status(404).json({ detail: data.error });
    }

    res.json(data);
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED') {
      return res.status(503).json({ detail: 'Python worker is not reachable' });
    }
    next(err);
  }
});


// ---- GET /jobs ----
// Returns all jobs for the authenticated user (admin sees all).
router.get('/jobs', auth, async (req, res, next) => {
  try {
    const filter = req.user.role === 'admin' ? {} : { user_id: req.user.id };
    const jobs = await Job.find(filter)
      .sort({ created_at: -1 })
      .select('_id file_name status mode created_at')
      .lean();

    // Batch-check which jobs have analysis/cleaning results
    const jobIds = jobs.map((j) => j._id);

    const [analysisHits, cleaningHits] = await Promise.all([
      AnalysisResult.find({ job_id: { $in: jobIds } }).select('job_id').lean(),
      CleaningResult.find({ job_id: { $in: jobIds } }).select('job_id').lean(),
    ]);

    const analysisSet = new Set(analysisHits.map((a) => a.job_id));
    const cleaningSet = new Set(cleaningHits.map((c) => c.job_id));

    const result = jobs.map((j) => ({
      _id: j._id,
      file_name: j.file_name || 'unknown',
      status: j.status,
      mode: j.mode,
      created_at: j.created_at,
      has_analysis: analysisSet.has(j._id),
      has_cleaning: cleaningSet.has(j._id),
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});


// ---- DELETE /jobs ----
// Delete one or multiple jobs. Body: { job_ids: ["id1", "id2", ...] }
// Deletes associated analysis/cleaning results and files on disk.
router.delete('/jobs', auth, async (req, res, next) => {
  try {
    const { job_ids } = req.body;
    if (!Array.isArray(job_ids) || job_ids.length === 0) {
      return res.status(400).json({ error: 'job_ids array is required' });
    }

    // Fetch jobs and enforce ownership
    const filter =
      req.user.role === 'admin'
        ? { _id: { $in: job_ids } }
        : { _id: { $in: job_ids }, user_id: req.user.id };

    const jobs = await Job.find(filter).lean();
    const ownedIds = jobs.map((j) => j._id);

    if (ownedIds.length === 0) {
      return res.status(404).json({ error: 'No matching jobs found' });
    }

    // Delete files on disk (best-effort, don't fail if missing)
    for (const job of jobs) {
      if (job.file_path) {
        try { fs.unlinkSync(job.file_path); } catch {}
      }
      if (job.cleaned_file_path) {
        try { fs.unlinkSync(job.cleaned_file_path); } catch {}
      }
    }

    // Delete from MongoDB
    await Promise.all([
      Job.deleteMany({ _id: { $in: ownedIds } }),
      AnalysisResult.deleteMany({ job_id: { $in: ownedIds } }),
      CleaningResult.deleteMany({ job_id: { $in: ownedIds } }),
    ]);

    // Audit log each deletion
    for (const id of ownedIds) {
      await auditLog(id, 'JOB_DELETED', { deleted_by: req.user.id });
    }

    res.json({ deleted: ownedIds.length, job_ids: ownedIds });
  } catch (err) {
    next(err);
  }
});


module.exports = router;
