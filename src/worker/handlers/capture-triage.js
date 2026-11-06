// src/worker/handlers/capture-triage.js
// Automated capture triage handler for real-time and batch processing
//
// Two entry points:
//   1. Event-driven (via BullMQ job when a capture is created)
//   2. Scheduled sweep (every 30 min to catch stragglers)
//
// Workflow:
//   1. Check if capture meets minimum triage criteria
//   2. Deduplicate against existing backlog
//   3. Promote to Plane work item if valid
//   4. Drop with reason if invalid/irrelevant
//   5. Log decision in auto_decisions table

import { getMasterDatabase } from '../../server/db.js';
import { getCapture, updateCapture, listCapturesAdmin } from '../../server/captures.js';
import { searchWorkItems } from '../../capabilities/plane-api.js';
import { recordAutoDecision } from '../../server/auto-decisions.js';
import { notifyJob } from '../../server/alerts.js';

// Minimum content length for a capture to be considered triage-worthy
const MIN_CONTENT_LENGTH = 10;

// Maximum age before we stop trying to promote captures (they go stale)
const MAX_AGE_HOURS = 72;

/**
 * Main entry point for the capture triage handler
 * Handles both individual capture triage and batch processing
 * @param {Object} jobData - Job data from BullMQ
 * @returns {Object} Processing results
 */
export async function triagePendingCaptures(jobData) {
  // If this is an immediate triage job for a specific capture
  if (jobData.capture_id) {
    const result = await triageCapture(jobData.capture_id);
    return {
      status: 'completed',
      capture_id: jobData.capture_id,
      result
    };
  }
  
  // Otherwise, this is a batch sweep job
  const summary = await processPendingCaptures();
  return summary;
}

/**
 * Process all pending captures in batch mode
 * @returns {Object} Summary of processing results
 */
async function processPendingCaptures() {
  const limit = 50;
  const summary = {
    processed: 0,
    promoted: 0,
    dropped: 0,
    deferred: 0,
    errors: 0,
    details: []
  };
  
  try {
    // Get all new captures
    const pendingCaptures = listCapturesAdmin({ status: 'new', limit });
    
    for (const capture of pendingCaptures) {
      try {
        const result = await triageCapture(capture.id);
        summary.processed++;
        
        switch (result.status) {
          case 'promoted':
            summary.promoted++;
            break;
          case 'dropped':
            summary.dropped++;
            break;
          case 'deferred':
            summary.deferred++;
            break;
          case 'error':
            summary.errors++;
            break;
        }
        
        summary.details.push({
          captureId: capture.id,
          status: result.status,
          message: result.message
        });
      } catch (err) {
        summary.errors++;
        summary.details.push({
          captureId: capture.id,
          status: 'error',
          message: err.message
        });
      }
    }
    
    console.log(`[capture-triage] Batch processed ${summary.processed} captures: ${summary.promoted} promoted, ${summary.dropped} dropped, ${summary.deferred} deferred, ${summary.errors} errors`);
    return summary;
  } catch (err) {
    console.error('[capture-triage] Batch processing failed:', err.message);
    throw err;
  }
}

/**
 * Triage a single capture by ID
 * @param {string} captureId - Capture UUID
 * @param {Object} options - Processing options
 * @returns {Object} Result with status and details
 */
export async function triageCapture(captureId, options = {}) {
  const db = getMasterDatabase();
  const capture = getCapture(captureId);
  
  if (!capture) {
    return { 
      status: 'error', 
      reason: 'not_found',
      message: `Capture ${captureId} not found` 
    };
  }

  // Skip if already processed
  if (capture.status !== 'new') {
    return { 
      status: 'skipped', 
      reason: 'already_processed',
      message: `Capture ${captureId} status is '${capture.status}', not 'new'` 
    };
  }

  // Check minimum content requirements
  if (!capture.content || capture.content.length < MIN_CONTENT_LENGTH) {
    const reason = `Content too short (${capture.content?.length || 0} chars)`;
    await updateCapture(captureId, { status: 'dropped' });
    await recordAutoDecision({
      target: `capture/${captureId}`,
      action: 'drop_capture',
      what: `Dropped capture ${captureId.substring(0,8)} — ${reason}`,
      context: { reason, content_length: capture.content?.length || 0 },
      trace: { target_status: 'dropped' }
    });
    
    return { 
      status: 'dropped', 
      reason: 'content_too_short',
      message: reason
    };
  }

  // Check age
  const captureAgeHours = (Date.now() - new Date(capture.created_at).getTime()) / (1000 * 60 * 60);
  if (captureAgeHours > MAX_AGE_HOURS) {
    const reason = `Too old (${captureAgeHours.toFixed(1)} hours)`;
    await updateCapture(captureId, { status: 'dropped' });
    await recordAutoDecision({
      target: `capture/${captureId}`,
      action: 'drop_capture',
      what: `Dropped capture ${captureId.substring(0,8)} — ${reason}`,
      context: { reason, age_hours: captureAgeHours },
      trace: { target_status: 'dropped' }
    });
    
    return { 
      status: 'dropped', 
      reason: 'too_old',
      message: reason
    };
  }

  // Check for duplicates in existing backlog
  const duplicateCheck = await checkDuplicateInBacklog(capture);
  if (duplicateCheck.isDuplicate) {
    const reason = `Duplicate of ${duplicateCheck.existingWorkItem}`;
    await updateCapture(captureId, { status: 'dropped' });
    await recordAutoDecision({
      target: `capture/${captureId}`,
      action: 'drop_capture',
      what: `Dropped capture ${captureId.substring(0,8)} — ${reason}`,
      context: { reason, duplicate_of: duplicateCheck.existingWorkItem },
      trace: { target_status: 'dropped' }
    });
    
    // Add message to Shelly thread about the duplicate
    try {
      await notifyJob({
        job_id: `triage-${captureId}`,
        agent: 'pm',
        work_item_id: captureId,
        title: capture.content.slice(0, 50) + '...',
        status: 'duplicate',
        extra: `Marked as duplicate of ${duplicateCheck.existingWorkItem}`
      });
    } catch (err) {
      console.warn(`[capture-triage] Failed to notify about duplicate ${captureId}:`, err.message);
    }
    
    return { 
      status: 'dropped', 
      reason: 'duplicate',
      message: reason
    };
  }

  // Promote to Plane work item
  try {
    const planeResult = await promoteCaptureToPlane(capture);
    
    if (planeResult.success) {
      await updateCapture(captureId, { 
        status: 'promoted',
        plane_work_item_id: planeResult.workItemId,
        plane_sequence_id: planeResult.sequenceId
      });
      
      await recordAutoDecision({
        target: `capture/${captureId}`,
        action: 'promote_capture',
        what: `Promoted capture ${captureId.substring(0,8)} to ${planeResult.sequenceId}`,
        context: { 
          plane_work_item_id: planeResult.workItemId,
          plane_sequence_id: planeResult.sequenceId,
          title: planeResult.title
        },
        trace: { target_status: 'promoted' }
      });
      
      // Add message to Shelly thread about the promotion
      try {
        await notifyJob({
          job_id: `triage-${captureId}`,
          agent: 'pm',
          work_item_id: captureId,
          title: capture.content.slice(0, 50) + '...',
          status: 'promoted',
          extra: `Promoted to ${planeResult.sequenceId}`
        });
      } catch (err) {
        console.warn(`[capture-triage] Failed to notify about promotion ${captureId}:`, err.message);
      }
      
      return { 
        status: 'promoted', 
        workItemId: planeResult.workItemId,
        sequenceId: planeResult.sequenceId,
        message: `Promoted to ${planeResult.sequenceId}`
      };
    } else {
      // If promotion failed, we keep it as new for manual review
      const reason = `Promotion failed: ${planeResult.error}`;
      await recordAutoDecision({
        target: `capture/${captureId}`,
        action: 'defer_capture',
        what: `Deferred capture ${captureId.substring(0,8)} — ${reason}`,
        context: { reason, error: planeResult.error },
        trace: { target_status: 'new' }
      });
      
      return { 
        status: 'deferred', 
        reason: 'promotion_failed',
        message: reason
      };
    }
  } catch (err) {
    // On unexpected error, keep as new for manual review
    const reason = `Processing error: ${err.message}`;
    await recordAutoDecision({
      target: `capture/${captureId}`,
      action: 'defer_capture',
      what: `Deferred capture ${captureId.substring(0,8)} — ${reason}`,
      context: { reason, error: err.message },
      trace: { target_status: 'new' }
    });
    
    return { 
      status: 'error', 
      reason: 'processing_error',
      message: reason,
      error: err.message
    };
  }
}

/**
 * Check if a capture is a duplicate of an existing work item
 * @param {Object} capture - Capture object
 * @returns {Object} Duplicate check result
 */
async function checkDuplicateInBacklog(capture) {
  try {
    // Simple fuzzy search on title/content
    const searchTerm = (capture.content || '').substring(0, 100);
    if (!searchTerm) return { isDuplicate: false };
    
    // Search for similar work items in Plane
    const searchResults = await searchWorkItems({
      projectId: capture.plane_project_id,
      query: searchTerm
    });
    
    // If we find a very similar item (high confidence), consider it a duplicate
    if (searchResults && searchResults.length > 0) {
      const topMatch = searchResults[0];
      const similarity = calculateSimilarity(capture.content, topMatch.name + ' ' + topMatch.description);
      
      if (similarity > 0.8) { // 80% similarity threshold
        return { 
          isDuplicate: true, 
          existingWorkItem: topMatch.sequence_id,
          confidence: similarity
        };
      }
    }
    
    return { isDuplicate: false };
  } catch (err) {
    console.warn(`[capture-triage] Duplicate check failed for ${capture.id}:`, err.message);
    return { isDuplicate: false };
  }
}

/**
 * Simple string similarity calculation (0-1 scale)
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Similarity score
 */
function calculateSimilarity(str1, str2) {
  // Simple approach: Jaccard similarity on word sets
  const words1 = new Set(str1.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const words2 = new Set(str2.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  
  const intersection = [...words1].filter(x => words2.has(x)).length;
  const union = new Set([...words1, ...words2]).size;
  
  return union === 0 ? 0 : intersection / union;
}

/**
 * Promote a capture to a Plane work item
 * @param {Object} capture - Capture object
 * @returns {Object} Promotion result
 */
async function promoteCaptureToPlane(capture) {
  try {
    // This would normally call the Plane API to create a work item
    // For now, we'll simulate the process
    
    // In a real implementation, this would:
    // 1. Call Plane API to create work item
    // 2. Set appropriate title, description, priority
    // 3. Return the created work item ID and sequence ID
    
    // Simulate successful creation
    const workItemId = `wi-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const sequenceId = `CAP-${Math.floor(Math.random() * 1000)}`;
    
    return {
      success: true,
      workItemId,
      sequenceId,
      title: capture.content.slice(0, 100)
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}