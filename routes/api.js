// routes/api.js - Storelistener REST API endpoints
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mongoose = require('mongoose');
const Store = require('../models/Store');
const Session = require('../models/Session');
const { generateFullAnalysis, analyzeRealtimeChunk } = require('../services/aiService');
const { transcribeAudio } = require('../services/sttService');

// Configure audio upload storage
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `session-${req.params.id || Date.now()}-${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });
const uploadMemory = multer({ storage: multer.memoryStorage() });

// Helper to seed stores if empty
async function ensureDefaultStores() {
  const count = await Store.countDocuments();
  if (count === 0) {
    await Store.create([
      { storeCode: 'STORE-NYC-01', name: 'Apple Authorized - 5th Ave', location: 'Manhattan, New York', manager: 'David Miller' },
      { storeCode: 'STORE-LA-02', name: 'iStore Premium - Beverly Hills', location: 'Los Angeles, California', manager: 'Sarah Jenkins' },
      { storeCode: 'STORE-MIA-03', name: 'Apple Hub - Brickell', location: 'Miami, Florida', manager: 'Carlos Rodriguez' }
    ]);
  }
}

// ---------------- STORES ----------------
router.get('/stores/overview', async (req, res) => {
  try {
    const storeSyncService = require('../services/storeSyncService');
    const stores = storeSyncService.getAllStoreStatuses();
    res.json({ success: true, stores });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/stores', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      await ensureDefaultStores();
      const stores = await Store.find({ isActive: true }).sort({ createdAt: -1 });
      return res.json({ success: true, stores });
    }
    // Resilient fallback to configured store statuses
    const storeSyncService = require('../services/storeSyncService');
    const stores = storeSyncService.getAllStoreStatuses();
    return res.json({ success: true, stores });
  } catch (err) {
    try {
      const storeSyncService = require('../services/storeSyncService');
      const stores = storeSyncService.getAllStoreStatuses();
      return res.json({ success: true, stores });
    } catch (fallbackErr) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
});

router.post('/stores', async (req, res) => {
  try {
    const { storeCode, name, location, manager } = req.body;
    const store = await Store.create({ storeCode, name, location, manager });
    res.json({ success: true, store });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------- SESSIONS ----------------
router.get('/sessions', async (req, res) => {
  try {
    const {
      storeCode,
      storeId,
      store,
      status,
      outcome,
      date,
      startDate,
      endDate,
      salesperson,
      sort = 'newest',
      limit = 50,
      page = 1,
    } = req.query;

    const query = {};

    const targetStore = store || storeCode || storeId;
    if (targetStore && targetStore !== 'all') {
      const storeSyncService = require('../services/storeSyncService');
      const cfg = storeSyncService.findStoreConfig(targetStore);
      query.$or = [
        { storeCode: cfg.code },
        { storeCode: cfg.id },
        { storeCode: targetStore },
        { storeName: new RegExp(targetStore, 'i') },
      ];
    }

    if (status && status !== 'all') {
      query.status = status;
    }

    if (outcome && outcome !== 'all') {
      query.$or = [
        { 'analytics.dealOutcome': outcome },
        { 'dealAnalysis.conversationOutcome': outcome },
      ];
    }

    if (salesperson && salesperson !== 'all') {
      query.salesRep = new RegExp(salesperson.trim(), 'i');
    }

    // Calendar-based date filtering (supports YYYY-MM-DD or ISO strings)
    if (date && date !== 'all') {
      const match = String(date).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (match) {
        const y = parseInt(match[1], 10);
        const m = parseInt(match[2], 10) - 1;
        const d = parseInt(match[3], 10);
        const tzOffsetMin = req.query.tzOffset !== undefined ? parseInt(req.query.tzOffset, 10) : new Date().getTimezoneOffset();
        const startOfDayMs = Date.UTC(y, m, d, 0, 0, 0, 0) + (tzOffsetMin * 60 * 1000);
        const endOfDayMs = Date.UTC(y, m, d, 23, 59, 59, 999) + (tzOffsetMin * 60 * 1000);
        query.startedAt = { $gte: new Date(startOfDayMs), $lte: new Date(endOfDayMs) };
      }
    } else if (startDate || endDate) {
      query.startedAt = {};
      if (startDate) query.startedAt.$gte = new Date(startDate);
      if (endDate) query.startedAt.$lte = new Date(endDate);
    }

    const sortOrder = sort === 'oldest' ? { startedAt: 1 } : { startedAt: -1 };
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [rawSessions, total] = await Promise.all([
      Session.find(query)
        .sort(sortOrder)
        .skip(skip)
        .limit(parseInt(limit)),
      Session.countDocuments(query),
    ]);

    const sessions = rawSessions.map((s) => {
      const doc = s.toObject ? s.toObject() : { ...s };
      if (!doc.audioUrl && doc.audioFileName) {
        doc.audioUrl = `/uploads/${doc.audioFileName}`;
      }
      doc.hasAudio = Boolean(doc.audioUrl || doc.audioFileName);
      return doc;
    });

    res.json({ success: true, total, sessions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/sessions/:id', async (req, res) => {
  try {
    const isObjectId = mongoose.Types.ObjectId.isValid(req.params.id);
    const session = await Session.findOne({
      $or: [{ sessionId: req.params.id }, ...(isObjectId ? [{ _id: req.params.id }] : [])],
    });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    const doc = session.toObject ? session.toObject() : { ...session };
    if (!doc.audioUrl && doc.audioFileName) {
      doc.audioUrl = `/uploads/${doc.audioFileName}`;
    }
    doc.hasAudio = Boolean(doc.audioUrl || doc.audioFileName);
    res.json({ success: true, session: doc });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sessions/:id/analysis - Return full persisted AI analysis report, or run it if pending
router.get('/sessions/:id/analysis', async (req, res) => {
  try {
    const isObjectId = mongoose.Types.ObjectId.isValid(req.params.id);
    let session = await Session.findOne({
      $or: [{ sessionId: req.params.id }, ...(isObjectId ? [{ _id: req.params.id }] : [])],
    });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const hasTranscripts = (session.transcripts?.length || 0) > 0;
    const isMissingAnalysis = !session.dealAnalysis || session.dealAnalysis.analysisStatus === 'pending' || session.dealAnalysis.analysisStatus === 'failed';

    if (session.status === 'completed' && isMissingAnalysis && hasTranscripts) {
      const dealAnalysisService = require('../services/dealAnalysisService');
      const scorecardService = require('../services/scorecardService');
      try {
        await dealAnalysisService.runAnalysisForSession(session.sessionId);
        await scorecardService.evaluateSessionScorecard(session.sessionId);
        session = await Session.findOne({ sessionId: session.sessionId });
      } catch (err) {
        console.warn('Auto-analysis error in /analysis endpoint:', err.message);
      }
    }

    res.json({
      success: true,
      session,
      dealAnalysis: session.dealAnalysis || null,
      scorecard: session.scorecard || null,
      analytics: session.analytics || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sessions/:id/analyze - Force re-run AI conversation report
router.post('/sessions/:id/analyze', async (req, res) => {
  try {
    const { force = true } = req.body;
    const isObjectId = mongoose.Types.ObjectId.isValid(req.params.id);
    let session = await Session.findOne({
      $or: [{ sessionId: req.params.id }, ...(isObjectId ? [{ _id: req.params.id }] : [])],
    });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const dealAnalysisService = require('../services/dealAnalysisService');
    const scorecardService = require('../services/scorecardService');

    const [dealAnalysis, scorecard] = await Promise.all([
      dealAnalysisService.runAnalysisForSession(session.sessionId, { force: Boolean(force) }),
      scorecardService.evaluateSessionScorecard(session.sessionId, { force: Boolean(force) }),
    ]);

    const updatedSession = await Session.findOne({ sessionId: session.sessionId });

    const io = req.app.get('io');
    if (io) {
      io.emit('deal_analysis_updated', {
        sessionId: session.sessionId,
        dealAnalysis,
        scorecard,
      });
    }

    res.json({
      success: true,
      session: updatedSession,
      dealAnalysis,
      scorecard,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start new conversation session from Desktop App
router.post('/sessions/start', async (req, res) => {
  try {
    const { sessionId, storeCode, storeName, deviceId, salesRep } = req.body;
    const newSession = await Session.create({
      sessionId: sessionId || `SES-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      storeCode: storeCode || 'STORE-NYC-01',
      storeName: storeName || 'Apple Store Downtown',
      deviceId: deviceId || 'terminal-pos-01',
      salesRep: salesRep || 'Sales Specialist',
      status: 'active',
      startedAt: new Date(),
      transcripts: []
    });

    // Notify connected admin dashboards
    const io = req.app.get('io');
    if (io) {
      io.emit('session_started', newSession);
    }

    res.json({ success: true, session: newSession });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Append transcript batch or chunk
router.post('/sessions/:id/transcript', async (req, res) => {
  try {
    const { text, speaker = 'customer', confidence = 0.95 } = req.body;
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const { translateToEnglish } = require('../services/translationService');
    const tr = await translateToEnglish(text);

    if (tr.isUnsupported) {
      return res.status(400).json({
        success: false,
        error: tr.error || 'Detected language is unsupported. Final transcript admits English only.',
      });
    }

    if (tr.translationFailed) {
      return res.status(502).json({
        success: false,
        error: 'Translation service unavailable for Spanish speech. Raw Spanish not admitted as English.',
      });
    }

    const canonicalEnglish = tr.englishText || text;

    const realtimeAnalysis = analyzeRealtimeChunk(canonicalEnglish, session.transcripts);
    const transcriptItem = {
      timestamp: new Date(),
      speaker: (speaker || '').toLowerCase().includes('sales') ? 'sales_rep' : 'customer',
      text: canonicalEnglish,
      englishText: canonicalEnglish,
      originalText: tr.originalText || text,
      sourceLanguage: tr.sourceLanguage || 'en',
      isTranslated: Boolean(tr.wasTranslated),
      confidence,
      signal: realtimeAnalysis.isClosingSignal ? 'CLOSING_SIGNAL' : (realtimeAnalysis.detectedObjection ? 'OBJECTION' : null)
    };

    session.transcripts.push(transcriptItem);
    await session.save();

    // Stream live chunk to socket clients
    const io = req.app.get('io');
    if (io) {
      io.to(`session_${session.sessionId}`).emit('transcript_chunk', {
        sessionId: session.sessionId,
        item: transcriptItem,
        realtimeAnalysis
      });
      io.emit('live_session_update', {
        sessionId: session.sessionId,
        storeCode: session.storeCode,
        latestText: canonicalEnglish,
        speaker: transcriptItem.speaker,
        probability: realtimeAnalysis.probability
      });
    }

    res.json({ success: true, realtimeAnalysis, item: transcriptItem });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// End and finalize session with full AI intelligence analysis
router.post('/sessions/:id/end', async (req, res) => {
  try {
    const { transcripts = [], durationSeconds } = req.body;
    let session = await Session.findOne({ sessionId: req.params.id });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (transcripts.length > 0 && session.transcripts.length === 0) {
      session.transcripts = transcripts;
    }

    const endedAt = new Date();
    const duration = durationSeconds || Math.max(10, Math.round((endedAt - new Date(session.startedAt)) / 1000));
    
    // Generate AI conversation analysis
    const fullAnalysis = await generateFullAnalysis(session.transcripts, { durationSeconds: duration });

    session.status = 'completed';
    session.endedAt = endedAt;
    session.durationSeconds = duration;
    session.analytics = fullAnalysis;

    await session.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('session_ended', session);
    }

    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Upload audio recording file (supports multipart file upload OR base64 JSON)
router.post('/sessions/:id/audio', (req, res, next) => {
  if (req.is('application/json')) {
    return next();
  }
  upload.single('audio')(req, res, next);
}, async (req, res) => {
  try {
    const sessionId = req.params.id;
    let fileName = null;

    if (req.file) {
      fileName = req.file.filename;
    } else if (req.body && (req.body.base64Data || req.body.audioBase64)) {
      const base64Data = req.body.base64Data || req.body.audioBase64;
      const mimeType = req.body.mimeType || 'audio/webm';
      let ext = '.webm';
      if (mimeType.includes('ogg')) ext = '.ogg';
      if (mimeType.includes('wav')) ext = '.wav';
      if (mimeType.includes('mp4') || mimeType.includes('m4a')) ext = '.mp4';

      fileName = `session-${sessionId}-${Date.now()}${ext}`;
      const filePath = path.join(uploadsDir, fileName);
      const buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(filePath, buffer);
    } else {
      return res.status(400).json({ success: false, error: 'No audio file or base64Data provided' });
    }

    const session = await Session.findOne({ sessionId });
    if (session) {
      session.audioFileName = fileName;
      session.audioUrl = `/uploads/${fileName}`;
      await session.save();
    }

    res.json({ success: true, audioUrl: `/uploads/${fileName}`, fileName });
  } catch (err) {
    console.error('[Audio Upload Error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stream audio recording for playback with HTTP 206 Partial Content (range requests)
router.get('/sessions/:id/audio', async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const fileName = session.audioFileName || (session.audioUrl ? path.basename(session.audioUrl) : null);
    if (!fileName) {
      return res.status(404).json({ success: false, error: 'Recording unavailable for this conversation' });
    }

    const filePath = path.join(uploadsDir, fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Recording file not found on disk' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const ext = path.extname(fileName).toLowerCase();
    let mimeType = 'audio/webm';
    if (ext === '.wav') mimeType = 'audio/wav';
    if (ext === '.ogg') mimeType = 'audio/ogg';
    if (ext === '.mp3') mimeType = 'audio/mpeg';
    if (ext === '.mp4' || ext === '.m4a') mimeType = 'audio/mp4';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Real-time Cloud Speech-to-Text Transcription for Urdu, Punjabi & English audio chunk
router.post('/sessions/:id/live-transcribe', uploadMemory.single('audioChunk'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, error: 'No audio chunk provided' });
    }

    const { language = 'auto', speaker = 'customer' } = req.body;
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // Transcribe with Cloud STT (Groq / OpenAI / Gemini)
    const sttResult = await transcribeAudio(req.file.buffer, req.file.mimetype || 'audio/webm', language);
    const transcribedText = (sttResult.text || '').trim();

    if (!transcribedText) {
      return res.json({ success: true, text: '', provider: sttResult.provider, note: 'Silence or no speech detected' });
    }

    // Ensure translation to canonical English
    const { translateToEnglish } = require('../services/translationService');
    const tr = await translateToEnglish(transcribedText);

    if (tr.isUnsupported) {
      return res.json({
        success: true,
        text: '',
        provider: sttResult.provider,
        note: `Unsupported language (${tr.sourceLanguage}) excluded from English transcript`,
      });
    }

    if (tr.translationFailed) {
      return res.json({
        success: true,
        text: '',
        provider: sttResult.provider,
        note: 'Spanish translation unavailable. Raw Spanish not admitted as English.',
      });
    }

    const canonicalEnglish = tr.englishText || transcribedText;

    // Realtime AI Intelligence
    const realtimeAnalysis = analyzeRealtimeChunk(canonicalEnglish, session.transcripts);
    const transcriptItem = {
      timestamp: new Date(),
      speaker: (speaker || '').toLowerCase().includes('sales') ? 'sales_rep' : 'customer',
      text: canonicalEnglish,
      englishText: canonicalEnglish,
      originalText: tr.originalText || transcribedText,
      sourceLanguage: tr.sourceLanguage || 'en',
      isTranslated: Boolean(tr.wasTranslated),
      confidence: 0.96,
      signal: realtimeAnalysis.isClosingSignal ? 'CLOSING_SIGNAL' : (realtimeAnalysis.detectedObjection ? 'OBJECTION' : null)
    };

    session.transcripts.push(transcriptItem);
    await session.save();

    // Stream live chunk to connected Admin dashboards over Socket.IO
    const io = req.app.get('io');
    if (io) {
      const payload = {
        sessionId: session.sessionId,
        text: canonicalEnglish,
        englishText: canonicalEnglish,
        originalText: transcriptItem.originalText,
        speaker: transcriptItem.speaker,
        isFinal: true,
        isTranslated: transcriptItem.isTranslated,
        sourceLanguage: transcriptItem.sourceLanguage,
        confidence: 0.96,
        timestamp: new Date(),
        realtimeAI: realtimeAnalysis,
        provider: sttResult.provider
      };
      io.to(`session_${session.sessionId}`).emit('transcript_stream_chunk', payload);
      io.emit('live_monitor_event', payload);

      if (realtimeAnalysis.isClosingSignal) {
        io.emit('deal_closure_detected', {
          sessionId: session.sessionId,
          signal: realtimeAnalysis.closingMatch,
          text: canonicalEnglish,
          timestamp: new Date()
        });
      }
    }

    res.json({
      success: true,
      text: transcribedText,
      provider: sttResult.provider,
      realtimeAnalysis,
      item: transcriptItem
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- ANALYTICS & DASHBOARD KPI ----------------
router.get('/analytics/dashboard', async (req, res) => {
  try {
    const { storeCode } = req.query;
    const filter = {};
    if (storeCode && storeCode !== 'all') {
      filter.storeCode = storeCode;
    }

    const sessions = await Session.find(filter).sort({ startedAt: -1 }).limit(100);

    const totalConversations = sessions.length;
    let wonCount = 0;
    let lostCount = 0;
    let negotiationCount = 0;
    let totalDuration = 0;
    let sentimentCount = { positive: 0, neutral: 0, negative: 0 };
    const deviceFrequency = {};
    const objectionFrequency = {};
    const repPerformance = {};

    sessions.forEach(s => {
      totalDuration += (s.durationSeconds || 0);
      const outcome = s.analytics?.dealOutcome || 'in_negotiation';
      if (outcome === 'won') wonCount++;
      else if (outcome === 'lost') lostCount++;
      else negotiationCount++;

      const sent = s.analytics?.customerSentiment || 'neutral';
      sentimentCount[sent] = (sentimentCount[sent] || 0) + 1;

      (s.analytics?.devicesDiscussed || []).forEach(d => {
        deviceFrequency[d] = (deviceFrequency[d] || 0) + 1;
      });

      (s.analytics?.objections || []).forEach(obj => {
        objectionFrequency[obj] = (objectionFrequency[obj] || 0) + 1;
      });

      const rep = s.salesRep || 'Sales Rep';
      if (!repPerformance[rep]) {
        repPerformance[rep] = { total: 0, won: 0, avgScore: 0, scores: [] };
      }
      repPerformance[rep].total++;
      if (outcome === 'won') repPerformance[rep].won++;
      if (s.analytics?.salesRepPerformance?.score) {
        repPerformance[rep].scores.push(s.analytics.salesRepPerformance.score);
      }
    });

    const winRate = totalConversations > 0 ? Math.round((wonCount / totalConversations) * 100) : 0;
    const avgDurationSeconds = totalConversations > 0 ? Math.round(totalDuration / totalConversations) : 0;

    // Format rep leaderboard
    const repLeaderboard = Object.entries(repPerformance).map(([name, data]) => ({
      name,
      total: data.total,
      won: data.won,
      rate: data.total > 0 ? Math.round((data.won / data.total) * 100) : 0,
      avgScore: data.scores.length > 0 ? Math.round(data.scores.reduce((a, b) => a + b, 0) / data.scores.length) : 85
    })).sort((a, b) => b.won - a.won);

    // Format top devices
    const topDevices = Object.entries(deviceFrequency)
      .map(([device, count]) => ({ device, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Format top objections
    const topObjections = Object.entries(objectionFrequency)
      .map(([objection, count]) => ({ objection, count }))
      .sort((a, b) => b.count - a.count);

    res.json({
      success: true,
      stats: {
        totalConversations,
        wonCount,
        lostCount,
        negotiationCount,
        winRate,
        avgDurationSeconds,
        sentimentBreakdown: sentimentCount,
        topDevices,
        topObjections,
        repLeaderboard,
        recentSessions: sessions.slice(0, 10)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- MODULE 6: DEAL ANALYSIS & REPORTING ----------------

// Trigger or retry conversation deal analysis manually
router.post('/sessions/:id/analyze', async (req, res) => {
  try {
    const dealAnalysisService = require('../services/dealAnalysisService');
    const sessionId = req.params.id;
    
    // Look up by sessionId or _id
    const session = await Session.findOne({
      $or: [{ sessionId }, { _id: sessionId.match(/^[0-9a-fA-F]{24}$/) ? sessionId : null }]
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const { force = true } = req.body || {};
    const analysis = await dealAnalysisService.runAnalysisForSession(session.sessionId, { force });

    // Stream update via socket if available
    const io = req.app.get('io');
    if (io) {
      io.emit('deal_analysis_updated', {
        sessionId: session.sessionId,
        storeCode: session.storeCode,
        dealAnalysis: analysis,
      });
    }

    res.json({ success: true, dealAnalysis: analysis, session });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fetch detailed deal analysis for a specific session
router.get('/sessions/:id/analysis', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const session = await Session.findOne({
      $or: [{ sessionId }, { _id: sessionId.match(/^[0-9a-fA-F]{24}$/) ? sessionId : null }]
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // If analysis was never run and transcript is present, trigger initial run
    if ((!session.dealAnalysis || session.dealAnalysis.analysisStatus === 'pending') && session.transcripts?.length > 0) {
      const dealAnalysisService = require('../services/dealAnalysisService');
      try {
        session.dealAnalysis = await dealAnalysisService.runAnalysisForSession(session.sessionId);
      } catch (e) {
        // Continue with whatever is in session
      }
    }

    res.json({
      success: true,
      dealAnalysis: session.dealAnalysis || null,
      session: {
        sessionId: session.sessionId,
        storeCode: session.storeCode,
        storeName: session.storeName,
        salesRep: session.salesRep,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationSeconds: session.durationSeconds,
        transcripts: session.transcripts || [],
        audioUrl: session.audioUrl || null,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function extractUserFromRequest(req) {
  try {
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }
    if (token) {
      const jwt = require('jsonwebtoken');
      const { JWT_SECRET } = require('../middleware/auth');
      return jwt.verify(token, JWT_SECRET);
    }
  } catch (e) {
    // Return null
  }
  return null;
}

// ---------------- DAILY REPORTS & AI AUDIT (TASK 2) ----------------
router.get('/reports/daily', async (req, res) => {
  try {
    const dailyReportService = require('../services/dailyReportService');
    const user = extractUserFromRequest(req);
    const report = await dailyReportService.getDailyReport(req.query, user);
    res.json({ success: true, report, ...report });
  } catch (err) {
    console.error('Daily report query error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/reports/daily/analyze', async (req, res) => {
  try {
    const dailyReportService = require('../services/dailyReportService');
    const user = extractUserFromRequest(req);
    const report = await dailyReportService.getDailyReport({ ...req.body, ...req.query, refresh: true }, user);
    res.json({ success: true, report, ...report });
  } catch (err) {
    console.error('Daily report analyze error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/reports/daily/pdf', async (req, res) => {
  try {
    const dailyReportService = require('../services/dailyReportService');
    const user = extractUserFromRequest(req);
    const reportData = await dailyReportService.getDailyReport(req.query, user);
    const doc = await dailyReportService.generateDailyReportPdf(reportData, user);

    const arrayBuffer = doc.output('arraybuffer');
    const pdfBuffer = Buffer.from(arrayBuffer);

    const safeDate = String(reportData.dateLabel || 'Daily_Report').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `Storelistener_Daily_Report_${safeDate}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF generation endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper to build MongoDB filter for deal reports
function buildDealReportsQuery(queryParams, user = null) {
  const { store, storeCode, dateRange, filterType, date, startDate, endDate, outcome, buyingIntent, salesperson, tzOffset } = queryParams;
  const filter = { status: 'completed' };

  // Store filter & role-based isolation
  if (user && user.role === 'sales_manager' && user.storeCode) {
    filter.storeCode = user.storeCode;
  } else {
    const targetStore = store || storeCode;
    if (targetStore && targetStore !== 'all') {
      const storeSyncService = require('../services/storeSyncService');
      const cfg = storeSyncService.findStoreConfig(targetStore);
      filter.$or = [
        { storeCode: cfg.code },
        { storeCode: cfg.id },
        { storeCode: targetStore },
        { storeId: targetStore },
        { storeId: cfg.id },
      ];
    }
  }

  // Consistent calendar range resolving via dailyReportService
  const dailyReportService = require('../services/dailyReportService');
  const resolved = dailyReportService.resolveDateRange({
    filterType: filterType || dateRange || 'all',
    date,
    startDate,
    endDate,
    tzOffset,
  });

  if (dateRange !== 'all' || filterType || date || startDate || endDate) {
    filter.startedAt = {
      $gte: resolved.startDate,
      $lte: resolved.endDate,
    };
  }

  // Salesperson filter
  if (salesperson && salesperson !== 'all') {
    filter.salesRep = new RegExp(salesperson.trim(), 'i');
  }

  // Outcome filter
  if (outcome && outcome !== 'all') {
    filter.$or = [
      { 'dealAnalysis.conversationOutcome': outcome },
      { 'dealAnalysis.salesOutcome': outcome },
    ];
  }

  // Buying Intent filter
  if (buyingIntent && buyingIntent !== 'all') {
    filter['dealAnalysis.customerBuyingIntent'] = buyingIntent;
  }

  return filter;
}

// Aggregated deal insights & reporting view
router.get('/analytics/deal-reports', async (req, res) => {
  try {
    const user = extractUserFromRequest(req);
    const filter = buildDealReportsQuery(req.query, user);
    const sortOrder = req.query.sort === 'oldest' ? { startedAt: 1 } : { startedAt: -1 };
    const sessions = await Session.find(filter).sort(sortOrder).limit(200);

    // Auto-analyze any completed sessions that don't have dealAnalysis yet
    const unanalyzed = sessions.filter(
      (s) => (!s.dealAnalysis || s.dealAnalysis.analysisStatus === 'pending') && (s.transcripts?.length || 0) > 0
    );

    if (unanalyzed.length > 0) {
      const dealAnalysisService = require('../services/dealAnalysisService');
      await Promise.all(
        unanalyzed.map(async (s) => {
          try {
            s.dealAnalysis = await dealAnalysisService.runAnalysisForSession(s.sessionId);
          } catch (e) {
            // Non-blocking
          }
        })
      );
    }

    // Metrics calculations strictly from persisted database records
    const totalCompleted = sessions.length;
    let confirmedSales = 0;
    let followUpRequired = 0;
    let notConverted = 0;
    let unclearOutcome = 0;

    const intentCounts = { High: 0, Medium: 0, Low: 0, Unclear: 0 };
    const storeMap = {
      'STORE-01': { code: 'STORE-01', name: 'iPhone Store 01 (5th Ave)', total: 0, confirmed: 0, followUp: 0, notConverted: 0, unclear: 0 },
      'STORE-02': { code: 'STORE-02', name: 'iPhone Store 02 (Beverly Hills)', total: 0, confirmed: 0, followUp: 0, notConverted: 0, unclear: 0 },
      'STORE-03': { code: 'STORE-03', name: 'iPhone Store 03 (Brickell)', total: 0, confirmed: 0, followUp: 0, notConverted: 0, unclear: 0 }
    };

    const dailyTrends = {};

    sessions.forEach((s) => {
      const analysis = s.dealAnalysis || {};
      const outcome = analysis.conversationOutcome || 'Unclear';
      const intent = analysis.customerBuyingIntent || 'Unclear';

      // Outcome tallies
      if (outcome === 'Sale Confirmed') confirmedSales++;
      else if (outcome === 'Follow-up Required') followUpRequired++;
      else if (outcome === 'Not Converted') notConverted++;
      else unclearOutcome++;

      // Intent tallies
      if (intentCounts[intent] !== undefined) {
        intentCounts[intent]++;
      } else {
        intentCounts.Unclear++;
      }

      // Store-wise comparisons
      const cleanStore = (s.storeCode || '').toUpperCase().includes('02')
        ? 'STORE-02'
        : (s.storeCode || '').toUpperCase().includes('03')
        ? 'STORE-03'
        : 'STORE-01';

      if (!storeMap[cleanStore]) {
        storeMap[cleanStore] = { code: cleanStore, name: s.storeName || cleanStore, total: 0, confirmed: 0, followUp: 0, notConverted: 0, unclear: 0 };
      }

      storeMap[cleanStore].total++;
      if (outcome === 'Sale Confirmed') storeMap[cleanStore].confirmed++;
      else if (outcome === 'Follow-up Required') storeMap[cleanStore].followUp++;
      else if (outcome === 'Not Converted') storeMap[cleanStore].notConverted++;
      else storeMap[cleanStore].unclear++;

      // Daily trends
      if (s.startedAt) {
        const dateKey = new Date(s.startedAt).toISOString().split('T')[0];
        if (!dailyTrends[dateKey]) {
          dailyTrends[dateKey] = { date: dateKey, total: 0, confirmed: 0, followUp: 0, notConverted: 0 };
        }
        dailyTrends[dateKey].total++;
        if (outcome === 'Sale Confirmed') dailyTrends[dateKey].confirmed++;
        else if (outcome === 'Follow-up Required') dailyTrends[dateKey].followUp++;
        else if (outcome === 'Not Converted') dailyTrends[dateKey].notConverted++;
      }
    });

    const conversionRate = totalCompleted > 0 ? Math.round((confirmedSales / totalCompleted) * 100) : 0;
    const followUpRate = totalCompleted > 0 ? Math.round((followUpRequired / totalCompleted) * 100) : 0;

    // Format store comparisons with conversion rates
    const storeComparisons = Object.values(storeMap).map((st) => ({
      ...st,
      conversionRate: st.total > 0 ? Math.round((st.confirmed / st.total) * 100) : 0,
      followUpRate: st.total > 0 ? Math.round((st.followUp / st.total) * 100) : 0,
    }));

    // Format intent breakdown
    const intentBreakdown = Object.entries(intentCounts).map(([level, count]) => ({
      level,
      count,
      percentage: totalCompleted > 0 ? Math.round((count / totalCompleted) * 100) : 0,
    }));

    // Formatted conversation records for table
    const conversationRecords = sessions.map((s) => ({
      id: s.sessionId || s._id,
      sessionId: s.sessionId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationSeconds: s.durationSeconds || 0,
      storeId: s.storeId || (s.storeCode ? s.storeCode.toLowerCase() : 'store-01'),
      storeCode: s.storeCode,
      storeName: s.storeName,
      salesRep: s.salesRep || 'Sales Specialist',
      summary: s.dealAnalysis?.summary || 'Not mentioned',
      customerRequirements: s.dealAnalysis?.customerRequirements || 'Not mentioned',
      productsDiscussed: s.dealAnalysis?.productsDiscussed || [],
      budgetAndPrice: s.dealAnalysis?.budgetAndPrice || 'Not mentioned',
      customerBuyingIntent: s.dealAnalysis?.customerBuyingIntent || 'Unclear',
      conversationOutcome: s.dealAnalysis?.conversationOutcome || 'Unclear',
      salespersonResponse: s.dealAnalysis?.salespersonResponse || 'Not mentioned',
      nextRecommendedAction: s.dealAnalysis?.nextRecommendedAction || 'Not mentioned',
      analysisStatus: s.dealAnalysis?.analysisStatus || 'pending',
      lastAnalyzedAt: s.dealAnalysis?.lastAnalyzedAt || null,
      transcriptsCount: s.transcripts?.length || 0,
      audioUrl: s.audioUrl || null,
    }));

    res.json({
      success: true,
      metrics: {
        totalCompleted,
        confirmedSales,
        followUpRequired,
        notConverted,
        unclearOutcome,
        conversionRate,
        followUpRate,
      },
      intentBreakdown,
      storeComparisons,
      dailyTrends: Object.values(dailyTrends).sort((a, b) => a.date.localeCompare(b.date)),
      conversations: conversationRecords,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// CSV Export for filtered reports
router.get('/analytics/export-csv', async (req, res) => {
  try {
    const user = extractUserFromRequest(req);
    const filter = buildDealReportsQuery(req.query, user);
    const sessions = await Session.find(filter).sort({ startedAt: -1 });

    const escapeCsv = (str) => {
      if (str === null || str === undefined) return '""';
      const clean = String(str).replace(/"/g, '""');
      return `"${clean}"`;
    };

    const headers = [
      'Session ID',
      'Date',
      'Time',
      'Store Code',
      'Store Name',
      'Sales Specialist',
      'Duration (sec)',
      'Products Discussed',
      'Budget / Price',
      'Customer Requirements',
      'Buying Intent',
      'Outcome',
      'Salesperson Response',
      'Next Recommended Action',
      'Summary',
    ];

    const rows = [headers.join(',')];

    sessions.forEach((s) => {
      const a = s.dealAnalysis || {};
      const dateObj = s.startedAt ? new Date(s.startedAt) : new Date();
      const dateStr = dateObj.toLocaleDateString();
      const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const row = [
        escapeCsv(s.sessionId),
        escapeCsv(dateStr),
        escapeCsv(timeStr),
        escapeCsv(s.storeCode),
        escapeCsv(s.storeName),
        escapeCsv(s.salesRep || 'Sales Specialist'),
        escapeCsv(s.durationSeconds || 0),
        escapeCsv((a.productsDiscussed || []).join('; ') || 'Not mentioned'),
        escapeCsv(a.budgetAndPrice || 'Not mentioned'),
        escapeCsv(a.customerRequirements || 'Not mentioned'),
        escapeCsv(a.customerBuyingIntent || 'Unclear'),
        escapeCsv(a.conversationOutcome || 'Unclear'),
        escapeCsv(a.salespersonResponse || 'Not mentioned'),
        escapeCsv(a.nextRecommendedAction || 'Not mentioned'),
        escapeCsv(a.summary || 'Not mentioned'),
      ];

      rows.push(row.join(','));
    });

    const csvContent = rows.join('\r\n');
    const timestamp = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="storelistener-deal-report-${timestamp}.csv"`);
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// MODULE 7: Salesperson Performance & Quality Scorecard API Endpoints
// =========================================================================

// Helper for JWT authentication & store isolation
function verifyScorecardAccess(req, requestedStore) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { allowed: true, user: null }; // Default allow internal requests if no token
  }

  const token = authHeader.split(' ')[1];
  try {
    const { JWT_SECRET } = require('../middleware/auth');
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, JWT_SECRET);

    // Sales managers are strictly isolated to their assigned storeCode
    if (decoded.role === 'sales_manager' && requestedStore && requestedStore !== 'all') {
      const userStore = (decoded.storeCode || '').toUpperCase().replace(/-/g, '');
      const reqStore = (requestedStore || '').toUpperCase().replace(/-/g, '');

      if (!reqStore.includes(userStore) && !userStore.includes(reqStore)) {
        return { allowed: false, forbidden: true, user: decoded };
      }
    }

    return { allowed: true, user: decoded };
  } catch (err) {
    return { allowed: false, invalidToken: true };
  }
}

// 1. Aggregated Salesperson Performance Overview
router.get('/scorecards/overview', async (req, res) => {
  try {
    const { store, salesperson, dateRange, startDate, endDate } = req.query;

    const authCheck = verifyScorecardAccess(req, store);
    if (authCheck.invalidToken) {
      return res.status(401).json({ success: false, error: 'Invalid or expired authorization token' });
    }
    if (authCheck.forbidden) {
      return res.status(403).json({ success: false, error: 'Access denied: Cannot access scorecard data for another retail store' });
    }

    // Build filter
    const filter = buildDealReportsQuery({ store, dateRange, startDate, endDate, salesperson });
    const sessions = await Session.find(filter).sort({ startedAt: -1 }).limit(300);

    const scorecardService = require('../services/scorecardService');

    // Auto-evaluate completed sessions with transcripts that lack scorecards
    const unScored = sessions.filter(
      (s) => (!s.scorecard || s.scorecard.status === 'pending') && (s.transcripts?.length || 0) > 0
    );

    if (unScored.length > 0) {
      await Promise.all(
        unScored.map(async (s) => {
          try {
            s.scorecard = await scorecardService.evaluateSessionScorecard(s.sessionId);
          } catch (e) {
            // Non-blocking
          }
        })
      );
    }

    // Aggregate by salesperson
    const repMap = {};
    const DIM_KEYS = [
      'greeting',
      'understandingRequirements',
      'productKnowledge',
      'responseToObjections',
      'communicationClarity',
      'handlingConcerns',
      'closingAttempt',
      'followUpCommitment',
    ];

    sessions.forEach((s) => {
      const repName = (s.salesRep || 'Sales Specialist').trim();
      if (!repMap[repName]) {
        repMap[repName] = {
          name: repName,
          storeCode: s.storeCode,
          storeName: s.storeName,
          totalConversations: 0,
          eligibleConversations: 0,
          overallScoresList: [],
          confirmedSalesCount: 0,
          followUpCount: 0,
          dimensionScoreSums: {},
          dimensionEvidenceCounts: {},
          handledWellList: [],
          areasToImproveList: [],
          recentScores: [],
          olderScores: [],
        };

        DIM_KEYS.forEach((k) => {
          repMap[repName].dimensionScoreSums[k] = 0;
          repMap[repName].dimensionEvidenceCounts[k] = 0;
        });
      }

      const rep = repMap[repName];
      rep.totalConversations++;

      // Check deal outcomes
      const outcome = s.dealAnalysis?.conversationOutcome;
      if (outcome === 'Sale Confirmed') rep.confirmedSalesCount++;
      if (outcome === 'Follow-up Required') rep.followUpCount++;

      // Scorecard metrics
      const card = s.scorecard;
      if (card && card.hasSufficientEvidence && typeof card.overallScore === 'number') {
        rep.eligibleConversations++;
        rep.overallScoresList.push(card.overallScore);

        if (rep.eligibleConversations <= 3) {
          rep.recentScores.push(card.overallScore);
        } else {
          rep.olderScores.push(card.overallScore);
        }

        // Tally dimensions
        if (card.dimensions) {
          DIM_KEYS.forEach((k) => {
            const d = card.dimensions[k];
            if (d && d.sufficientEvidence === true && typeof d.score === 'number') {
              rep.dimensionScoreSums[k] += d.score;
              rep.dimensionEvidenceCounts[k]++;
            }
          });
        }

        // Tally coaching feedback
        if (card.coachingFeedback?.handledWell) {
          card.coachingFeedback.handledWell.forEach((hw) => {
            if (hw && !rep.handledWellList.includes(hw)) rep.handledWellList.push(hw);
          });
        }
        if (card.coachingFeedback?.areasToImprove) {
          card.coachingFeedback.areasToImprove.forEach((ai) => {
            if (ai && !rep.areasToImproveList.includes(ai)) rep.areasToImproveList.push(ai);
          });
        }
      }
    });

    // Format finalized salesperson cards
    const salespeople = Object.values(repMap).map((r) => {
      const overallAvg =
        r.overallScoresList.length > 0
          ? Math.round(r.overallScoresList.reduce((a, b) => a + b, 0) / r.overallScoresList.length)
          : null;

      const dimensionAverages = {};
      DIM_KEYS.forEach((k) => {
        const count = r.dimensionEvidenceCounts[k];
        dimensionAverages[k] =
          count > 0 ? Math.round(r.dimensionScoreSums[k] / count) : null;
      });

      // Performance trend calculation
      let trendPercent = 0;
      if (r.recentScores.length > 0 && r.olderScores.length > 0) {
        const recentAvg = r.recentScores.reduce((a, b) => a + b, 0) / r.recentScores.length;
        const olderAvg = r.olderScores.reduce((a, b) => a + b, 0) / r.olderScores.length;
        trendPercent = Math.round(recentAvg - olderAvg);
      }

      return {
        name: r.name,
        storeCode: r.storeCode,
        storeName: r.storeName,
        totalConversations: r.totalConversations,
        eligibleConversations: r.eligibleConversations,
        overallScore: overallAvg,
        dimensionAverages,
        confirmedSalesCount: r.confirmedSalesCount,
        followUpCount: r.followUpCount,
        conversionRate: r.totalConversations > 0 ? Math.round((r.confirmedSalesCount / r.totalConversations) * 100) : 0,
        topStrengths: r.handledWellList.slice(0, 3),
        topImprovementAreas: r.areasToImproveList.slice(0, 3),
        trend: trendPercent,
        sampleSizeNote:
          r.eligibleConversations > 0
            ? `Based on ${r.eligibleConversations} eligible conversation(s) with sufficient transcript evidence`
            : 'Insufficient evidence to compute score — no conversations with >= 2 evaluable dimensions',
      };
    });

    res.json({
      success: true,
      salespeople,
      totalSessionsEvaluated: sessions.length,
      scoringRubric: scorecardService.getRubricMetadata(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Salesperson Deep-Dive Scorecard
router.get('/scorecards/salesperson/:name', async (req, res) => {
  try {
    const rawName = decodeURIComponent(req.params.name);
    const repName = rawName.trim();

    const authCheck = verifyScorecardAccess(req, req.query.store);
    if (authCheck.invalidToken) {
      return res.status(401).json({ success: false, error: 'Invalid or expired authorization token' });
    }
    if (authCheck.forbidden) {
      return res.status(403).json({ success: false, error: 'Access denied: Cannot access scorecard for another store location' });
    }

    const sessions = await Session.find({
      status: 'completed',
      salesRep: new RegExp(`^${repName}$`, 'i'),
    })
      .sort({ startedAt: -1 })
      .limit(60);

    const scorecardService = require('../services/scorecardService');

    const formattedSessions = sessions.map((s) => ({
      sessionId: s.sessionId,
      startedAt: s.startedAt,
      durationSeconds: s.durationSeconds || 0,
      storeCode: s.storeCode,
      storeName: s.storeName,
      outcome: s.dealAnalysis?.conversationOutcome || 'Unclear',
      buyingIntent: s.dealAnalysis?.customerBuyingIntent || 'Unclear',
      productsDiscussed: s.dealAnalysis?.productsDiscussed || [],
      scorecard: s.scorecard || null,
      coachingFeedback: s.scorecard?.coachingFeedback || null,
      transcripts: s.transcripts || [],
    }));

    res.json({
      success: true,
      salesperson: repName,
      conversations: formattedSessions,
      scoringRubric: scorecardService.getRubricMetadata(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Conversation-Level Scorecard & Coaching Feedback
router.get('/scorecards/session/:id', async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const authCheck = verifyScorecardAccess(req, session.storeCode);
    if (authCheck.invalidToken) {
      return res.status(401).json({ success: false, error: 'Invalid or expired authorization token' });
    }
    if (authCheck.forbidden) {
      return res.status(403).json({ success: false, error: 'Access denied: Cannot access session from another store location' });
    }

    const scorecardService = require('../services/scorecardService');

    // Auto-evaluate if pending and has transcripts
    if ((!session.scorecard || session.scorecard.status === 'pending') && (session.transcripts?.length || 0) > 0) {
      session.scorecard = await scorecardService.evaluateSessionScorecard(session.sessionId);
    }

    res.json({
      success: true,
      scorecard: session.scorecard || null,
      session: {
        sessionId: session.sessionId,
        storeCode: session.storeCode,
        storeName: session.storeName,
        salesRep: session.salesRep,
        workstation: session.workstation,
        durationSeconds: session.durationSeconds,
        startedAt: session.startedAt,
        dealAnalysis: session.dealAnalysis,
        transcripts: session.transcripts,
      },
      scoringRubric: scorecardService.getRubricMetadata(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Trigger / Retry Scorecard Evaluation for a Session
router.post('/scorecards/session/:id/evaluate', async (req, res) => {
  try {
    const { force = false } = req.body;
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const authCheck = verifyScorecardAccess(req, session.storeCode);
    if (authCheck.invalidToken) {
      return res.status(401).json({ success: false, error: 'Invalid or expired authorization token' });
    }
    if (authCheck.forbidden) {
      return res.status(403).json({ success: false, error: 'Access denied: Cannot evaluate session for another store' });
    }

    const scorecardService = require('../services/scorecardService');
    const scorecard = await scorecardService.evaluateSessionScorecard(session.sessionId, { force });

    // Broadcast update via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('scorecard_updated', {
        sessionId: session.sessionId,
        storeCode: session.storeCode,
        scorecard,
      });
    }

    res.json({
      success: true,
      scorecard,
      session,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// MODULE 8: Smart Alerts & Notifications REST Endpoints
// =========================================================================

const notificationService = require('../services/notificationService');

// Helper to extract authenticated user from cookie or request header
function getAuthUser(req) {
  const token = req.cookies?.token || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null);
  if (!token) return null;
  try {
    const { JWT_SECRET } = require('../middleware/auth');
    const jwt = require('jsonwebtoken');
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// 1. Get notifications with filters, pagination, and store isolation
router.get('/notifications', async (req, res) => {
  try {
    const user = getAuthUser(req);
    const result = await notificationService.getNotifications(req.query, user);
    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Get unread notification count
router.get('/notifications/unread-count', async (req, res) => {
  try {
    const user = getAuthUser(req);
    const unreadCount = await notificationService.getUnreadCount(user);
    res.json({ success: true, unreadCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Mark single notification as read
router.patch('/notifications/:id/read', async (req, res) => {
  try {
    const user = getAuthUser(req);
    const io = req.app.get('io');
    const notification = await notificationService.markAsRead(req.params.id, user, io);
    res.json({ success: true, notification });
  } catch (err) {
    const status = err.message.includes('Access denied') ? 403 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// 4. Mark all notifications as read within user scope
router.post('/notifications/mark-all-read', async (req, res) => {
  try {
    const user = getAuthUser(req);
    const io = req.app.get('io');
    const result = await notificationService.markAllAsRead(user, io);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Delete a notification
router.delete('/notifications/:id', async (req, res) => {
  try {
    const user = getAuthUser(req);
    const io = req.app.get('io');
    const result = await notificationService.deleteNotification(req.params.id, user, io);
    res.json({ success: true, ...result });
  } catch (err) {
    const status = err.message.includes('Access denied') ? 403 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// 6. Get notification rules and settings
router.get('/notifications/settings', async (req, res) => {
  try {
    const settings = await notificationService.getSettings();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Update notification rules and thresholds
router.put('/notifications/settings', async (req, res) => {
  try {
    const user = getAuthUser(req);
    if (user && user.role === 'sales_manager') {
      return res.status(403).json({ success: false, error: 'Access denied: Only Store Admins can modify alert rules.' });
    }
    const settings = await notificationService.updateSettings(req.body);
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Manual trigger endpoint for testing and explicit event testing
router.post('/notifications/trigger-test', async (req, res) => {
  try {
    const io = req.app.get('io');
    const alertData = {
      idempotencyKey: req.body.idempotencyKey || `test_manual:${Date.now()}:${Math.random().toString(36).substr(2, 6)}`,
      ...req.body,
    };
    const notification = await notificationService.createNotification(alertData, io);
    res.json({ success: true, notification });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// MODULE 9: Customer & Sales Intelligence
// ==========================================
const salesIntelligenceService = require('../services/salesIntelligenceService');

// 1. Comprehensive intelligence overview (Product demand, Lost sales, Store comparison, Trends)
router.get('/intelligence/overview', async (req, res) => {
  try {
    const user = getAuthUser(req);
    const data = await salesIntelligenceService.getIntelligenceOverview(req.query, user);
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Product demand rankings with intent levels, price ranges, and questions/objections
router.get('/intelligence/products', async (req, res) => {
  try {
    const user = getAuthUser(req);
    const data = await salesIntelligenceService.getIntelligenceOverview(req.query, user);
    res.json({
      success: true,
      productDemand: data.productDemand,
      totalUniqueProducts: data.summary.totalUniqueProducts,
      appliedFilters: data.appliedFilters,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Lost sales & customer objections breakdown
router.get('/intelligence/lost-sales', async (req, res) => {
  try {
    const user = getAuthUser(req);
    const data = await salesIntelligenceService.getIntelligenceOverview(req.query, user);
    res.json({
      success: true,
      lostSalesAndObjections: data.lostSalesAndObjections,
      unconvertedCount: data.summary.unconvertedCount,
      followUpsCount: data.summary.followUpsCount,
      unclearOutcomesCount: data.summary.unclearOutcomesCount,
      appliedFilters: data.appliedFilters,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Store-by-store comparison benchmarks
router.get('/intelligence/stores', async (req, res) => {
  try {
    const user = getAuthUser(req);
    const data = await salesIntelligenceService.getIntelligenceOverview(req.query, user);
    res.json({
      success: true,
      storeComparison: data.storeComparison,
      conversionMetricDisclosure: data.summary.conversionMetricDisclosure,
      appliedFilters: data.appliedFilters,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Customer requirements and follow-up opportunities
router.get('/intelligence/customer-needs', async (req, res) => {
  try {
    const user = getAuthUser(req);
    const data = await salesIntelligenceService.getIntelligenceOverview(req.query, user);
    res.json({
      success: true,
      customerRequirements: data.customerRequirements,
      totalRequirements: data.customerRequirements.length,
      appliedFilters: data.appliedFilters,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. CSV Export of filtered customer and sales intelligence data
router.get('/intelligence/export-csv', async (req, res) => {
  try {
    const user = getAuthUser(req);
    const data = await salesIntelligenceService.getIntelligenceOverview(req.query, user);
    const csvContent = salesIntelligenceService.generateCSV(data);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="sales_intelligence_report.csv"');
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

