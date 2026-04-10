import express from 'express';
import {
  getProjectByApiKey,
  createTicket,
  getTicket,
  listTickets,
  updateTicket,
  deleteTicket,
  getStats
} from './db.js';

const router = express.Router();

// ============================================================================
// MIDDLEWARE - API Key Auth
// ============================================================================

function authenticateProject(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key. Provide via X-API-Key header or api_key query param.' });
  }

  const project = getProjectByApiKey(apiKey);

  if (!project) {
    return res.status(401).json({ error: 'Invalid API key.' });
  }

  // Attach project to request
  req.project = project;
  next();
}

export function createRouter(config = {}) {
  const storagePath = config.storagePath || './storage';

  // ============================================================================
  // PUBLIC ENDPOINTS (No auth)
  // ============================================================================

  // Health check
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ============================================================================
  // PROJECT-SCOPED ENDPOINTS (API Key required)
  // ============================================================================

  // Create ticket
  router.post('/tickets', authenticateProject, async (req, res) => {
    try {
      const { type, title, description, context, screenshot, created_by } = req.body;

      if (!type || !title || !description) {
        return res.status(400).json({ error: 'Missing required fields: type, title, description' });
      }

      // Handle base64 screenshot
      let screenshotBuffer = null;
      let screenshotMimeType = null;

      if (screenshot) {
        // Extract base64 data and mime type
        const matches = screenshot.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          screenshotMimeType = matches[1];
          screenshotBuffer = Buffer.from(matches[2], 'base64');
        }
      }

      const ticketId = createTicket(storagePath, req.project.id, {
        type,
        title,
        description,
        context,
        screenshot: screenshotBuffer,
        screenshot_mime_type: screenshotMimeType,
        created_by
      });

      res.status(201).json({
        id: ticketId,
        message: 'Ticket created successfully',
        project: req.project.name
      });
    } catch (error) {
      console.error('Error creating ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get ticket details
  router.get('/tickets/:id', authenticateProject, (req, res) => {
    try {
      const ticket = getTicket(storagePath, req.project.id, parseInt(req.params.id));

      if (!ticket) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      // Don't send screenshot BLOB in JSON response
      const { screenshot, ...ticketWithoutBlob } = ticket;
      ticketWithoutBlob.has_screenshot = !!screenshot;

      res.json(ticketWithoutBlob);
    } catch (error) {
      console.error('Error getting ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // List tickets
  router.get('/tickets', authenticateProject, (req, res) => {
    try {
      const { status, limit } = req.query;

      const tickets = listTickets(storagePath, req.project.id, {
        status,
        limit: limit ? parseInt(limit) : undefined
      });

      res.json({
        project: req.project.name,
        tickets
      });
    } catch (error) {
      console.error('Error listing tickets:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get screenshot
  router.get('/tickets/:id/screenshot', authenticateProject, (req, res) => {
    try {
      const ticket = getTicket(storagePath, req.project.id, parseInt(req.params.id));

      if (!ticket) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      if (!ticket.screenshot) {
        return res.status(404).json({ error: 'No screenshot for this ticket' });
      }

      // Send BLOB as image
      res.set('Content-Type', ticket.screenshot_mime_type || 'image/png');
      res.send(ticket.screenshot);
    } catch (error) {
      console.error('Error getting screenshot:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Update ticket
  router.patch('/tickets/:id', authenticateProject, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;

      // Add timestamp for certain status changes
      if (updates.status === 'published' && !updates.reviewed_at) {
        updates.reviewed_at = new Date().toISOString();
      }

      updateTicket(storagePath, req.project.id, id, updates);

      res.json({ message: 'Ticket updated successfully' });
    } catch (error) {
      console.error('Error updating ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Delete/reject ticket
  router.delete('/tickets/:id', authenticateProject, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { reason } = req.body;

      if (reason) {
        // Soft delete: mark as rejected
        updateTicket(storagePath, req.project.id, id, {
          status: 'rejected',
          rejection_reason: reason,
          reviewed_at: new Date().toISOString()
        });
      } else {
        // Hard delete
        deleteTicket(storagePath, req.project.id, id);
      }

      res.json({ message: 'Ticket deleted successfully' });
    } catch (error) {
      console.error('Error deleting ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get stats
  router.get('/stats', authenticateProject, (req, res) => {
    try {
      const stats = getStats(storagePath, req.project.id);

      res.json({
        project: req.project.name,
        stats
      });
    } catch (error) {
      console.error('Error getting stats:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
