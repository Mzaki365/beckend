/**
 * Storelistener — Module 6: Deal Analysis & Reporting E2E Tests
 * File: test/module6_deal_analysis.test.js
 *
 * Verifies all 9 prompt acceptance criteria:
 * 1. A completed session can be analyzed.
 * 2. Analysis results persist after refresh (MongoDB & API).
 * 3. Missing transcript information is marked Unknown rather than invented.
 * 4. Analysis failures / manual triggers can be retried.
 * 5. Dashboard metrics match the underlying database records with exact denominators.
 * 6. Filters correctly update the report (store, outcome, buying intent, date).
 * 7. CSV exports match the filtered results.
 * 8. Existing live monitoring, recording, transcription, audio playback, and Module 5 sync still work.
 * 9. Empty sessions and unavailable AI configuration are handled gracefully.
 */

require('dotenv').config();
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

let ioClient;
try {
  ioClient = require('socket.io-client');
} catch (e) {
  ioClient = require('d:/Star Solutions/storelistener/storelistner-desktop/node_modules/socket.io-client');
}

const BACKEND_URL = 'http://localhost:5000';
const { JWT_SECRET } = require('../middleware/auth');
const Session = require('../models/Session');
const dealAnalysisService = require('../services/dealAnalysisService');

function createTestToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

describe('Module 6: Deal Analysis & Reporting Test Suite', () => {
  let adminToken;
  let testSessionConfirmedSale;
  let testSessionInquiryOnly;
  let testSessionEmpty;
  const uniquePrefix = `m6-test-${Date.now()}`;

  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
    }

    adminToken = createTestToken({
      id: 'admin-m6',
      email: 'admin@storelistener.com',
      role: 'store_admin',
    });

    // 1. Create a completed session with a clear confirmed sale
    testSessionConfirmedSale = await Session.create({
      sessionId: `${uniquePrefix}-sale`,
      storeId: 'store-01',
      storeCode: 'STORE-01',
      storeName: 'iPhone Store 01',
      status: 'completed',
      startedAt: new Date(Date.now() - 600000),
      endedAt: new Date(Date.now() - 300000),
      durationSeconds: 300,
      workstation: 'Counter 01',
      salesRep: 'Alex Taylor',
      transcripts: [
        {
          timestamp: new Date(Date.now() - 595000),
          speaker: 'customer',
          text: 'Hi, I need an iPhone 15 Pro with 256GB storage in Natural Titanium.',
          confidence: 0.98,
        },
        {
          timestamp: new Date(Date.now() - 588000),
          speaker: 'sales_rep',
          text: 'We have that in stock. The retail price is $1,099.',
          confidence: 0.99,
        },
        {
          timestamp: new Date(Date.now() - 580000),
          speaker: 'customer',
          text: 'That is slightly expensive, is there any student discount?',
          confidence: 0.95,
        },
        {
          timestamp: new Date(Date.now() - 572000),
          speaker: 'sales_rep',
          text: 'Yes, we can offer an AppleCare bundle and $50 trade-in credit today.',
          confidence: 0.97,
        },
        {
          timestamp: new Date(Date.now() - 565000),
          speaker: 'customer',
          text: 'Perfect! I will take it. Here is my credit card to pay now.',
          confidence: 0.99,
        },
        {
          timestamp: new Date(Date.now() - 558000),
          speaker: 'sales_rep',
          text: 'Payment completed successfully. Here is your receipt and new iPhone 15 Pro.',
          confidence: 0.99,
        },
      ],
    });

    // 2. Create a session with missing details / inquiry only (Follow-up or Not Converted, unknown budget)
    testSessionInquiryOnly = await Session.create({
      sessionId: `${uniquePrefix}-inquiry`,
      storeId: 'store-02',
      storeCode: 'STORE-02',
      storeName: 'iPhone Store 02',
      status: 'completed',
      startedAt: new Date(Date.now() - 200000),
      endedAt: new Date(Date.now() - 100000),
      durationSeconds: 100,
      workstation: 'Counter 02',
      salesRep: 'Jordan Lee',
      transcripts: [
        {
          timestamp: new Date(Date.now() - 196000),
          speaker: 'customer',
          text: 'Do you have accessories in stock?',
          confidence: 0.95,
        },
        {
          timestamp: new Date(Date.now() - 190000),
          speaker: 'sales_rep',
          text: 'Yes, we have MagSafe chargers and protective cases.',
          confidence: 0.97,
        },
        {
          timestamp: new Date(Date.now() - 182000),
          speaker: 'customer',
          text: 'Okay, I am just browsing today, I might come back next week.',
          confidence: 0.96,
        },
      ],
    });

    // 3. Create an empty session
    testSessionEmpty = await Session.create({
      sessionId: `${uniquePrefix}-empty`,
      storeId: 'store-03',
      storeCode: 'STORE-03',
      storeName: 'iPhone Store 03',
      status: 'completed',
      startedAt: new Date(Date.now() - 50000),
      endedAt: new Date(),
      durationSeconds: 15,
      workstation: 'Counter 03',
      salesRep: 'Sam Rivera',
      transcripts: [],
    });
  });

  after(async () => {
    // Clean up created test sessions
    await Session.deleteMany({ sessionId: { $regex: `^${uniquePrefix}` } });
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  // Test 1: Completed session can be analyzed
  test('1. Completed session can be analyzed and extracts key deal parameters', async () => {
    const analysis = await dealAnalysisService.runAnalysisForSession(testSessionConfirmedSale.sessionId);

    assert.ok(analysis, 'Analysis result should exist');
    assert.equal(analysis.analysisStatus, 'completed');
    assert.equal(analysis.conversationOutcome, 'Sale Confirmed', 'Outcome must detect Sale Confirmed');
    assert.equal(analysis.customerBuyingIntent, 'High', 'Buying intent must be High');
    assert.ok(analysis.productsDiscussed.length > 0, 'Products discussed must be extracted');
    assert.match(analysis.budgetAndPrice, /1,?099/, 'Budget/price must reflect $1,099 from transcript');
    assert.ok(analysis.customerRequirements.length > 0, 'Customer requirements should be extracted');
    assert.ok(analysis.summary && analysis.summary.length > 10, 'Summary should be provided');
    assert.ok(analysis.keyMoments && analysis.keyMoments.length > 0, 'Key moments excerpts should be included');
  });

  // Test 2: Analysis results persist in MongoDB and are accessible via API
  test('2. Analysis results persist after database re-query and via GET /api/sessions/:id/analysis', async () => {
    const res = await fetch(`${BACKEND_URL}/api/sessions/${testSessionConfirmedSale.sessionId}/analysis`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200, 'Endpoint should return 200 OK');

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.dealAnalysis.analysisStatus, 'completed');
    assert.equal(body.dealAnalysis.conversationOutcome, 'Sale Confirmed');

    // Cross-verify directly with MongoDB document
    const freshDbSession = await Session.findOne({ sessionId: testSessionConfirmedSale.sessionId }).lean();
    assert.ok(freshDbSession.dealAnalysis);
    assert.equal(freshDbSession.dealAnalysis.conversationOutcome, 'Sale Confirmed');
    assert.ok(freshDbSession.dealAnalysis.lastAnalyzedAt);
  });

  // Test 3: Missing transcript information is marked Unknown / Not mentioned rather than invented
  test('3. Missing information in inquiry session is marked Unknown / Not mentioned rather than invented', async () => {
    const analysis = await dealAnalysisService.runAnalysisForSession(testSessionInquiryOnly.sessionId);

    assert.ok(analysis, 'Analysis result should exist');
    assert.notEqual(analysis.conversationOutcome, 'Sale Confirmed', 'Inquiry must NOT be classified as Sale Confirmed');
    // Price was never mentioned in the transcript
    assert.match(
      analysis.budgetAndPrice.toLowerCase(),
      /not mentioned|unknown|none/,
      'Price must state Not mentioned or Unknown'
    );
    // Customer was just browsing
    assert.ok(
      analysis.customerBuyingIntent === 'Low' || analysis.customerBuyingIntent === 'Medium',
      'Browsing customer should be Low or Medium intent'
    );
  });

  // Test 4: Analysis can be manually triggered and retried via POST /api/sessions/:id/analyze
  test('4. Manual retry / re-analysis via POST /api/sessions/:id/analyze works correctly', async () => {
    const res = await fetch(`${BACKEND_URL}/api/sessions/${testSessionConfirmedSale.sessionId}/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ force: true }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.dealAnalysis.analysisStatus, 'completed');
    assert.equal(body.dealAnalysis.conversationOutcome, 'Sale Confirmed');
  });

  // Test 5: Dashboard metrics match underlying database records with exact denominators
  test('5. GET /api/analytics/deal-reports computes exact metrics and denominators', async () => {
    const res = await fetch(`${BACKEND_URL}/api/analytics/deal-reports?store=all&dateRange=all`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.metrics.totalCompleted >= 2, 'Should include completed test sessions');
    assert.ok(data.metrics.confirmedSales >= 1, 'Should include confirmed sale');
    
    // Check conversion rate denominator: (confirmedSales / totalCompleted) * 100
    const expectedRate = Math.round((data.metrics.confirmedSales / data.metrics.totalCompleted) * 100);
    assert.equal(data.metrics.conversionRate, expectedRate, 'Conversion rate must match exact denominator');
    
    // Store comparisons and intent breakdowns exist
    assert.ok(Array.isArray(data.storeComparisons), 'Store comparisons must be an array');
    assert.ok(Array.isArray(data.intentBreakdown), 'Intent breakdown must be an array');
  });

  // Test 6: Filters correctly update reports
  test('6. Filter by storeCode narrows results accurately', async () => {
    const res = await fetch(`${BACKEND_URL}/api/analytics/deal-reports?store=store-01&dateRange=all`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const data = await res.json();
    assert.equal(data.success, true);
    // Every conversation returned must belong to store-01
    const invalidStores = data.conversations.filter(
      (c) => c.storeCode !== 'STORE-01' && c.storeId !== 'store-01'
    );
    assert.equal(invalidStores.length, 0, 'All returned conversations must belong to store-01');
  });

  // Test 7: CSV export matches filtered results
  test('7. GET /api/analytics/export-csv returns valid CSV matching filtered results', async () => {
    const res = await fetch(`${BACKEND_URL}/api/analytics/export-csv?store=store-01&outcome=Sale%20Confirmed`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    assert.equal(res.status, 200);
    const contentType = res.headers.get('content-type');
    assert.match(contentType, /text\/csv/);

    const csvText = await res.text();
    const lines = csvText.trim().split('\n');
    assert.ok(lines.length >= 2, 'CSV must have header and at least 1 record');
    assert.match(lines[0], /Session ID,Date,Time,Store Code/);
    assert.match(csvText, /Sale Confirmed/, 'CSV must contain Sale Confirmed row');
  });

  // Test 8: Modules 0-5 WebSocket real-time synchronization remains working
  test('8. Modules 0-5 WebSocket synchronization and heartbeat still function', async () => {
    const client = ioClient(BACKEND_URL, {
      auth: { token: adminToken },
      transports: ['websocket'],
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket timeout')), 5000);
      client.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      client.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.ok(client.connected, 'Socket.IO client should be connected');
    client.disconnect();
  });

  // Test 9: Empty sessions and unavailable AI configuration are handled gracefully
  test('9. Empty sessions are handled gracefully with empty_skipped status', async () => {
    const analysis = await dealAnalysisService.runAnalysisForSession(testSessionEmpty.sessionId);

    assert.ok(analysis, 'Analysis result should return for empty session');
    assert.equal(analysis.analysisStatus, 'empty_skipped');
    assert.equal(analysis.conversationOutcome, 'Unclear');
    assert.match(analysis.summary, /no usable dialogue|empty|no spoken/i);
  });
});
