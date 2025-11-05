import express from 'express';
import { 
  connectSession, 
  getSessionStatus, 
  disconnect, 
  deleteSessionController,
  getUserSessionsList, 
  checkSessionActive, 
  clearAllSessionsController, 
  healthCheck,
  getAllSessions,
  restoreSessionController
} from '../controllers/session.controller.js';

const router = express.Router();

router.get('/health', healthCheck);
router.get('/all', getAllSessions);
router.post('/connect', connectSession);
router.post('/clear', clearAllSessionsController);
router.get('/user/:userId/sessions', getUserSessionsList);
router.get('/:sessionId/status', getSessionStatus);
router.get('/:sessionId/active', checkSessionActive);
router.post('/:sessionId/restore', restoreSessionController);
router.post('/:sessionId/disconnect', disconnect);
router.delete('/:sessionId', deleteSessionController);

export default router;
