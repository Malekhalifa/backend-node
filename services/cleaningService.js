/**
 * Cleaning Service — delegates ALL data processing to the Python worker.
 *
 * Node does NOT read/parse CSVs or clean data.
 * It only: calls Python via HTTP, stores the result in MongoDB, updates job status.
 */

const Job = require('../models/Job');
const CleaningResult = require('../models/CleaningResult');
const { auditLog } = require('../db/postgres');

const PYTHON_URL = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';

// 10-minute timeout for large file cleaning
const CLEANING_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run cleaning by delegating to Python worker.
 * @param {string} jobId
 * @param {object} cleaningOptions - { mode: "auto"|"manual", rules?: {...} }
 */
async function runCleaning(jobId, cleaningOptions = {}) {
  const job = await Job.findById(jobId);
  if (!job || !job.file_path) throw new Error('Job/file not found');

  await Job.updateOne({ _id: jobId }, { $set: { status: 'cleaning' } });
  await auditLog(jobId, 'CLEANING_STARTED', { mode: cleaningOptions.mode });

  try {
    // Call Python worker via HTTP
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLEANING_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(`${PYTHON_URL}/internal/clean`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: jobId,
          file_path: job.file_path,
          mode: cleaningOptions.mode || 'auto',
          rules: cleaningOptions.rules || {},
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

    if (data.status === 'failed') {
      throw new Error(data.error || 'Python cleaning failed');
    }

    // Store the cleaning result in MongoDB
    await CleaningResult.replaceOne(
      { job_id: jobId },
      {
        job_id: jobId,
        mode: data.mode || cleaningOptions.mode || 'auto',
        rules_applied: data.rules_applied,
        summary: data.summary,
      },
      { upsert: true }
    );

    // Update job with cleaned file path and status
    await Job.updateOne(
      { _id: jobId },
      { $set: { cleaned_file_path: data.cleaned_file_path, status: 'cleaned' } }
    );

    for (const r of data.rules_applied) {
      await auditLog(jobId, 'RULE_APPLIED', r);
    }
    await auditLog(jobId, 'CLEANING_COMPLETED', {
      cleaned_file_path: data.cleaned_file_path,
      rows_removed: data.summary.rows_removed,
    });
  } catch (err) {
    await Job.updateOne({ _id: jobId }, { $set: { status: 'completed' } });
    await auditLog(jobId, 'ERROR', { phase: 'cleaning', error: err.message });
    throw err;
  }
}

module.exports = { runCleaning };
