/**
 * Analysis Service — delegates ALL data processing to the Python worker.
 *
 * Node does NOT read/parse CSVs or compute metrics.
 * It only: calls Python via HTTP, stores the result in MongoDB, updates job status.
 */

const Job = require('../models/Job');
const AnalysisResult = require('../models/AnalysisResult');
const { auditLog } = require('../db/postgres');

const PYTHON_URL = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';

// 10-minute timeout for large file analysis
const ANALYSIS_TIMEOUT_MS = 10 * 60 * 1000;

async function runAnalysis(jobId) {
  const job = await Job.findById(jobId);
  if (!job || !job.file_path) throw new Error('Job/file not found');

  await Job.updateOne({ _id: jobId }, { $set: { status: 'running' } });
  await auditLog(jobId, 'ANALYSIS_STARTED', {});

  try {
    // Call Python worker via HTTP
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(`${PYTHON_URL}/internal/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: jobId,
          file_path: job.file_path,
          mode: job.mode || 'normal',
          options: {},
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Python service returned HTTP ${response.status}`);
    }

    const data = await response.json();

    // Python returns { job_id, status, result } or { job_id, status, error }
    if (data.status === 'failed') {
      throw new Error(data.error || 'Python analysis failed');
    }

    // Store the full result in MongoDB
    await AnalysisResult.replaceOne(
      { job_id: jobId },
      {
        job_id: jobId,
        result: data.result, // { cleaned_data, quality_report, meta }
        analysis_type: data.result?.meta?.analysis_type || 'in-memory',
      },
      { upsert: true }
    );

    await Job.updateOne({ _id: jobId }, { $set: { status: 'completed' } });
    await auditLog(jobId, 'ANALYSIS_COMPLETED', {
      analysis_type: data.result?.meta?.analysis_type,
      duration_ms: data.result?.meta?.duration_ms,
    });
  } catch (err) {
    await Job.updateOne({ _id: jobId }, { $set: { status: 'failed' } });
    await auditLog(jobId, 'ANALYSIS_FAILED', { error: err.message });
    throw err;
  }
}

module.exports = { runAnalysis };
