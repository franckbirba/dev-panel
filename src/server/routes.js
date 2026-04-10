import express from 'express';
import multer from 'multer';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import {
  createTicket,
  getTicket,
  listTickets,
  updateTicket,
  deleteTicket,
  getStats
} from './db.js';

const router = express.Router();

// Configure multer for file uploads
function configureUpload(storagePath) {
  const uploadPath = join(storagePath, 'uploads');

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const date = new Date().toISOString().split('T')[0];
      const dayPath = join(uploadPath, date);

      if (!existsSync(dayPath)) {
        mkdirSync(dayPath, { recursive: true });
      }

      cb(null, dayPath);
    },
    filename: (req, file, cb) => {
      const timestamp = Date.now();
      const ext = file.originalname.split('.').pop();
      cb(null, `screenshot-${timestamp}.${ext}`);
    }
  });

  return multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
      const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed'));
      }
    }
  });
}

export function createRouter(config = {}) {
  const upload = configureUpload(config.storagePath || './storage');

  // USER ENDPOINTS

  // Create ticket
  router.post('/tickets', upload.single('screenshot'), (req, res) => {
    try {
      const { type, title, description, context, created_by, project } = req.body;

      if (!type || !title || !description) {
        return res.status(400).json({ error: 'Missing required fields: type, title, description' });
      }

      let screenshot_path = null;
      if (req.file) {
        // Store relative path
        const date = new Date().toISOString().split('T')[0];
        screenshot_path = `uploads/${date}/${req.file.filename}`;
      }

      const ticketId = createTicket({
        type,
        title,
        description,
        context: typeof context === 'string' ? JSON.parse(context) : context,
        screenshot_path,
        created_by,
        project: project || config.project
      });

      res.status(201).json({
        id: ticketId,
        message: 'Ticket created successfully'
      });
    } catch (error) {
      console.error('Error creating ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get ticket details
  router.get('/tickets/:id', (req, res) => {
    try {
      const ticket = getTicket(parseInt(req.params.id));

      if (!ticket) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      res.json(ticket);
    } catch (error) {
      console.error('Error getting ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // List tickets
  router.get('/tickets', (req, res) => {
    try {
      const { status, project, limit } = req.query;

      const tickets = listTickets({
        status,
        project,
        limit: limit ? parseInt(limit) : undefined
      });

      res.json(tickets);
    } catch (error) {
      console.error('Error listing tickets:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get screenshot
  router.get('/tickets/:id/screenshot', (req, res) => {
    try {
      const ticket = getTicket(parseInt(req.params.id));

      if (!ticket) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      if (!ticket.screenshot_path) {
        return res.status(404).json({ error: 'No screenshot for this ticket' });
      }

      const screenshotPath = join(config.storagePath || './storage', ticket.screenshot_path);

      if (!existsSync(screenshotPath)) {
        return res.status(404).json({ error: 'Screenshot file not found' });
      }

      res.sendFile(screenshotPath);
    } catch (error) {
      console.error('Error getting screenshot:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // PM ENDPOINTS

  // Update ticket (review, publish, etc.)
  router.patch('/tickets/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;

      // Add timestamp for certain status changes
      if (updates.status === 'published' && !updates.reviewed_at) {
        updates.reviewed_at = new Date().toISOString();
      }

      updateTicket(id, updates);

      res.json({ message: 'Ticket updated successfully' });
    } catch (error) {
      console.error('Error updating ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Delete/reject ticket
  router.delete('/tickets/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { reason } = req.body;

      if (reason) {
        // Soft delete: mark as rejected
        updateTicket(id, {
          status: 'rejected',
          rejection_reason: reason,
          reviewed_at: new Date().toISOString()
        });
      } else {
        // Hard delete
        deleteTicket(id);
      }

      res.json({ message: 'Ticket deleted successfully' });
    } catch (error) {
      console.error('Error deleting ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get stats
  router.get('/stats', (req, res) => {
    try {
      const { project } = req.query;
      const stats = getStats(project);

      res.json(stats);
    } catch (error) {
      console.error('Error getting stats:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Health check
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return router;
}
