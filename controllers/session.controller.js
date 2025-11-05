import sessionModel from "../models/session.js";
import {
  startNewSession,
  disconnectSession,
  deleteSession,
  getUserSessions,
  isSessionActive,
  getClient,
  clearAllSessions,
  getAllActiveSessions,
  restoreSession,
} from "../services/waManager.js";

import pkg from "whatsapp-web.js";
const { Buttons } = pkg;
import fs from "fs";

/* ---------------------------
   Session endpoints
----------------------------*/

// POST /api/wa/session/connect
export const connectSession = async (req, res) => {
  try {
    const userId = req.body.userId || "test-user-1";
    const sessionName = req.body.sessionName || req.body.name || '';
    const forceNew = Boolean(req.body.forceNew || req.query.force || req.query.forceNew || req.body.force);
    const sessionId = await startNewSession(userId, sessionName, forceNew);
    
    console.log(`🔗 Session created: "${sessionName || sessionId}" (${userId})`);
    
    return res.json({ 
      sessionId, 
      userId,
      sessionName: sessionName || null
    });
  } catch (err) {
    console.error("Error creating session:", err.message);
    return res.status(500).json({ error: "Unable to create session", details: err.message });
  }
};

// GET /api/wa/session/:sessionId/status
export const getSessionStatus = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await sessionModel.findOne({ sessionId });
    if (!session) return res.status(404).json({ error: "Session not found" });
    return res.json({
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      userId: session.userId,
      status: session.status,
      phoneNumber: session.phoneNumber,
      qr: session.qr,
    });
  } catch (err) {
    console.error("Error getting session status:", err.message);
    return res.status(500).json({ error: "Unable to get session status", details: err.message });
  }
};

// POST /api/wa/session/:sessionId/disconnect
export const disconnect = async (req, res) => {
  try {
    const { sessionId } = req.params;
    await disconnectSession(sessionId);
    return res.json({ status: "disconnected" });
  } catch (err) {
    console.error("Error disconnecting session:", err.message);
    return res.status(500).json({ error: "Unable to disconnect session", details: err.message });
  }
};

// DELETE /api/wa/session/:sessionId
export const deleteSessionController = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await deleteSession(sessionId);
    
    if (!result) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    return res.json({ 
      success: true, 
      message: "Session deleted successfully",
      sessionId 
    });
  } catch (err) {
    console.error("Error deleting session:", err.message);
    return res.status(500).json({ error: "Unable to delete session", details: err.message });
  }
};

// GET /api/wa/session/user/:userId/sessions
export const getUserSessionsList = async (req, res) => {
  try {
    const { userId } = req.params;
    const sessions = await getUserSessions(userId);
    const activeSessions = getAllActiveSessions();
    
    // Mark which sessions are currently active in memory
    const sessionsWithStatus = sessions.map((s) => {
      const activeInfo = activeSessions.find(a => a.sessionId === s.sessionId);
      return {
        sessionId: s.sessionId,
        sessionName: s.sessionName,
        userId: s.userId,
        status: s.status,
        isInMemory: !!activeInfo,
        isReady: activeInfo?.isReady || false,
        phoneNumber: s.phoneNumber || activeInfo?.phoneNumber || null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    });
    
    // Find the best active session
    const bestSession = sessionsWithStatus.find(s => s.isReady && s.status === 'connected') ||
                       sessionsWithStatus.find(s => s.status === 'connected') ||
                       sessionsWithStatus.find(s => s.status === 'authenticated');
    
    return res.json({
      userId,
      totalSessions: sessions.length,
      activeReady: sessionsWithStatus.filter(s => s.isReady).length,
      recommendedSession: bestSession?.sessionId || null,
      sessions: sessionsWithStatus,
    });
  } catch (err) {
    console.error("Error getting user sessions:", err.message);
    return res.status(500).json({ error: "Unable to get user sessions", details: err.message });
  }
};

// GET /api/wa/session/:sessionId/active
export const checkSessionActive = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const isActive = await isSessionActive(sessionId);
    let hasClient = false;
    try {
      const client = getClient(sessionId);
      hasClient = !!client;
    } catch {}
    return res.json({
      sessionId,
      isActive,
      hasClient,
      status: isActive ? "ready" : "not_ready",
    });
  } catch (err) {
    console.error("Error checking session:", err.message);
    return res.status(500).json({ error: "Unable to check session status", details: err.message });
  }
};

// POST /api/wa/session/clear
export const clearAllSessionsController = async (req, res) => {
  try {
    const result = await clearAllSessions();
    return res.json({
      message: "All sessions cleared successfully",
      cleared: result.cleared,
    });
  } catch (err) {
    console.error("Error clearing sessions:", err.message);
    return res.status(500).json({ error: "Unable to clear sessions", details: err.message });
  }
};

// GET /api/wa/session/health
export const healthCheck = async (req, res) => {
  try {
    const activeSessionsCount = await sessionModel.countDocuments({
      status: { $in: ["connected", "authenticated"] },
    });
    const activeSessions = getAllActiveSessions();
    
    return res.json({
      status: "healthy",
      activeSessions: activeSessionsCount,
      activeClients: activeSessions.length,
      sessions: activeSessions,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Health check error:", err.message);
    return res.status(500).json({ error: "Health check failed", details: err.message });
  }
};

// GET /api/wa/session/all
export const getAllSessions = async (req, res) => {
  try {
    const activeSessions = getAllActiveSessions();
    const dbSessions = await sessionModel.find({}).sort({ updatedAt: -1 });
    
    return res.json({
      activeInMemory: activeSessions,
      sessions: dbSessions.map(s => ({
        sessionId: s.sessionId,
        sessionName: s.sessionName,
        userId: s.userId,
        status: s.status,
        phoneNumber: s.phoneNumber,
        qr: s.qr, // Include QR code for frontend display
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
      totalActive: activeSessions.length,
      totalInDb: dbSessions.length,
    });
  } catch (err) {
    console.error("Error getting all sessions:", err.message);
    return res.status(500).json({ error: "Unable to get sessions", details: err.message });
  }
};

// POST /api/wa/session/:sessionId/restore
export const restoreSessionController = async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }

    console.log(`♻️ Manual restore requested for: ${sessionId}`);
    await restoreSession(sessionId);
    
    return res.json({
      success: true,
      message: "Session restored successfully",
      sessionId,
    });
  } catch (err) {
    console.error("Error restoring session:", err.message);
    return res.status(500).json({ 
      error: "Unable to restore session", 
      details: err.message 
    });
  }
};
