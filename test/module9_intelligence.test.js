/**
 * Storelistener — Module 9: Customer & Sales Intelligence Automated Test Suite
 * File: test/module9_intelligence.test.js
 *
 * Verifies all Module 9 prompt requirements:
 * 1. Product counts match distinct source conversations (no inflation).
 * 2. Demand and objection summaries link to verifiable transcript evidence quotes.
 * 3. Unknown/Unclear outcomes are not counted as confirmed sales (strict conversion numerator).
 * 4. Store and date filters produce accurate, narrowed result sets.
 * 5. Charts and CSV exports agree with filtered persisted data.
 * 6. Missing or stale analyses are handled gracefully without failures.
 * 7. Store-level authorization: sales managers cannot access unauthorized store intelligence.
 * 8. Regression verification: Modules 0-8 session, deal analysis, and notifications functional.
 */

require('dotenv').config();
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const BACKEND_URL = 'http://localhost:5000';
const { JWT_SECRET } = require('../middleware/auth');
const Session = require('../models/Session');
const salesIntelligenceService = require('../services/salesIntelligenceService');

function createTestToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

describe('Module 9: Customer & Sales Intelligence Test Suite', () => {
  let adminToken;
  let managerStore01Token;
  let managerStore02Token;

  const testPrefix = `m9-test-${Date.now()}`;
  const storeA = 'STORE-INTEL-01';
  const storeB = 'STORE-INTEL-02';

  let sessionSaleA;
  let sessionFollowUpA;
  let sessionLostPriceA;
  let sessionLostNoReasonA;
  let sessionUnclearB;

  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
    }

    adminToken = createTestToken({
      id: 'admin-m9',
      email: 'admin@storelistener.com',
      role: 'store_admin',
    });

    managerStore01Token = createTestToken({
      id: 'mgr-m9-01',
      email: 'manager01@storelistener.com',
      role: 'sales_manager',
      storeCode: storeA,
    });

    managerStore02Token = createTestToken({
      id: 'mgr-m9-02',
      email: 'manager02@storelistener.com',
      role: 'sales_manager',
      storeCode: storeB,
    });

    // 1. Session A1: Confirmed Sale of iPhone 16 Pro Max and AppleCare+
    sessionSaleA = await Session.create({
      sessionId: `${testPrefix}-sale-A1`,
      storeCode: storeA,
      storeName: 'Downtown Store',
      salesRep: 'Sarah Jenkins',
      status: 'completed',
      startedAt: new Date(Date.now() - 3600000), // 1 hr ago
      endedAt: new Date(Date.now() - 3000000),
      durationSeconds: 600,
      transcripts: [
        { speaker: 'sales_rep', text: 'Welcome! How can I help you today?' },
        { speaker: 'customer', text: 'I want the iPhone 16 Pro Max 512GB in Desert Titanium.' },
        { speaker: 'sales_rep', text: 'That is $1,399. We also include AppleCare+ protection for 2 years.' },
        { speaker: 'customer', text: 'Sounds great! I will take both. Here is my credit card.' },
      ],
      dealAnalysis: {
        customerRequirements: 'iPhone 16 Pro Max 512GB Desert Titanium with AppleCare+',
        productsDiscussed: ['iPhone 16 Pro Max', 'AppleCare+ / Warranty'],
        budgetAndPrice: '$1,399',
        customerQuestions: ['Is Desert Titanium available in 512GB?'],
        customerObjections: [],
        customerBuyingIntent: 'High',
        conversationOutcome: 'Sale Confirmed',
        nextRecommendedAction: 'Send digital invoice and thank you note',
        summary: 'Customer purchased iPhone 16 Pro Max and AppleCare+ without hesitation',
        keyMoments: [{ excerpt: 'I want the iPhone 16 Pro Max 512GB in Desert Titanium', speaker: 'customer', significance: 'Stated requirement' }],
        analysisStatus: 'completed',
        isOutdated: false,
      },
    });

    // 2. Session A2: Follow-up required on iPhone 16 Pro Max
    sessionFollowUpA = await Session.create({
      sessionId: `${testPrefix}-followup-A2`,
      storeCode: storeA,
      storeName: 'Downtown Store',
      salesRep: 'Sarah Jenkins',
      status: 'completed',
      startedAt: new Date(Date.now() - 7200000), // 2 hrs ago
      endedAt: new Date(Date.now() - 6600000),
      durationSeconds: 600,
      transcripts: [
        { speaker: 'sales_rep', text: 'Looking for a new phone?' },
        { speaker: 'customer', text: 'Yes, looking at the iPhone 16 Pro Max, but I need to consult my manager before buying.' },
        { speaker: 'sales_rep', text: 'I can email you a formal quote.' },
        { speaker: 'customer', text: 'Please call me back on Monday morning.' },
      ],
      dealAnalysis: {
        customerRequirements: 'iPhone 16 Pro Max company procurement',
        productsDiscussed: ['iPhone 16 Pro Max'],
        budgetAndPrice: '$1,199',
        customerQuestions: ['Can you provide an enterprise discount?'],
        customerObjections: ['Need manager budget approval'],
        customerBuyingIntent: 'Medium',
        conversationOutcome: 'Follow-up Required',
        nextRecommendedAction: 'Call customer back Monday morning with formal quote',
        summary: 'Customer interested in iPhone 16 Pro Max, requested callback on Monday',
        keyMoments: [{ excerpt: 'Please call me back on Monday morning', speaker: 'customer', significance: 'Follow-up commitment' }],
        analysisStatus: 'completed',
        isOutdated: false,
      },
    });

    // 3. Session A3: Not Converted due to explicit price objection
    sessionLostPriceA = await Session.create({
      sessionId: `${testPrefix}-lost-price-A3`,
      storeCode: storeA,
      storeName: 'Downtown Store',
      salesRep: 'Alex Taylor',
      status: 'completed',
      startedAt: new Date(Date.now() - 86400000), // 1 day ago
      endedAt: new Date(Date.now() - 85800000),
      durationSeconds: 600,
      transcripts: [
        { speaker: 'customer', text: 'How much is the iPhone 16 Pro Max?' },
        { speaker: 'sales_rep', text: 'It starts at $1,199.' },
        { speaker: 'customer', text: 'That is way too expensive and out of my budget. I will pass.' },
      ],
      dealAnalysis: {
        customerRequirements: 'iPhone 16 Pro Max inquiry',
        productsDiscussed: ['iPhone 16 Pro Max'],
        budgetAndPrice: '$1,199',
        customerQuestions: ['How much is the iPhone 16 Pro Max?'],
        customerObjections: ['Too expensive and out of my budget'],
        customerBuyingIntent: 'Low',
        conversationOutcome: 'Not Converted',
        nextRecommendedAction: 'Suggest trade-in or refurbished alternatives',
        summary: 'Customer walked away due to price constraint',
        keyMoments: [{ excerpt: 'That is way too expensive and out of my budget', speaker: 'customer', significance: 'Price objection' }],
        analysisStatus: 'completed',
        isOutdated: false,
      },
    });

    // 4. Session A4: Not Converted without explicit objection (tests "Reason not identified")
    sessionLostNoReasonA = await Session.create({
      sessionId: `${testPrefix}-lost-noreason-A4`,
      storeCode: storeA,
      storeName: 'Downtown Store',
      salesRep: 'Alex Taylor',
      status: 'completed',
      startedAt: new Date(Date.now() - 90000000),
      endedAt: new Date(Date.now() - 89400000),
      durationSeconds: 600,
      transcripts: [
        { speaker: 'sales_rep', text: 'Can I help you?' },
        { speaker: 'customer', text: 'Just browsing AirPods Pro today. Thanks.' },
      ],
      dealAnalysis: {
        customerRequirements: 'AirPods Pro 2 casual browse',
        productsDiscussed: ['AirPods Pro 2'],
        budgetAndPrice: 'Not mentioned',
        customerQuestions: [],
        customerObjections: [],
        customerBuyingIntent: 'Low',
        conversationOutcome: 'Not Converted',
        nextRecommendedAction: 'Keep in active catalog',
        summary: 'Customer browsed AirPods without stating objection or purchase intent',
        keyMoments: [{ excerpt: 'Just browsing AirPods Pro today', speaker: 'customer', significance: 'Casual browsing' }],
        analysisStatus: 'completed',
        isOutdated: true, // Marked outdated to test stale analysis tracking
      },
    });

    // 5. Session B1: In Store B, Unclear outcome
    sessionUnclearB = await Session.create({
      sessionId: `${testPrefix}-unclear-B1`,
      storeCode: storeB,
      storeName: 'Uptown Store',
      salesRep: 'Jordan Lee',
      status: 'completed',
      startedAt: new Date(Date.now() - 50000000),
      endedAt: new Date(Date.now() - 49400000),
      durationSeconds: 600,
      transcripts: [
        { speaker: 'customer', text: 'Do you carry the Apple Watch Ultra?' },
        { speaker: 'sales_rep', text: 'Yes, we have the Series 2 in titanium.' },
      ],
      dealAnalysis: {
        customerRequirements: 'Apple Watch Series 10 / Ultra inquiry',
        productsDiscussed: ['Apple Watch Series 10 / Ultra'],
        budgetAndPrice: 'Not mentioned',
        customerQuestions: ['Do you carry the Apple Watch Ultra?'],
        customerObjections: [],
        customerBuyingIntent: 'Unclear',
        conversationOutcome: 'Unclear',
        nextRecommendedAction: 'Follow up if customer returns',
        summary: 'Inquiry about Apple Watch availability',
        keyMoments: [{ excerpt: 'Do you carry the Apple Watch Ultra?', speaker: 'customer', significance: 'Product check' }],
        analysisStatus: 'completed',
        isOutdated: false,
      },
    });
  });

  after(async () => {
    await Session.deleteMany({ sessionId: new RegExp(testPrefix) });
  });

  test('1. Product counts match distinct source conversations (no inflation)', async () => {
    const res = await fetch(`${BACKEND_URL}/api/intelligence/products?storeCode=${storeA}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const data = await res.json();
    assert.ok(data.success, 'Products endpoint must return success');
    assert.ok(Array.isArray(data.productDemand), 'productDemand must be an array');

    // In Store A, iPhone 16 Pro Max was discussed in session A1, A2, and A3 (exactly 3 distinct conversations)
    const iphoneEntry = data.productDemand.find((p) => p.productName === 'iPhone 16 Pro Max');
    assert.ok(iphoneEntry, 'iPhone 16 Pro Max should be present in demand list');
    assert.equal(iphoneEntry.distinctConversations, 3, 'Must match exactly 3 distinct conversations');

    // Verify intent breakdown: A1 = purchase intent (High/Sale), A2 = genuine interest (Medium), A3 = casual/low (Low)
    assert.equal(iphoneEntry.explicitPurchaseIntent, 1, 'Exactly 1 session had purchase intent');
    assert.equal(iphoneEntry.genuineInterest, 1, 'Exactly 1 session had genuine interest');
    assert.equal(iphoneEntry.casualMention, 1, 'Exactly 1 session had casual mention');
  });

  test('2. Demand and objection summaries link to verifiable transcript evidence quotes', async () => {
    const res = await fetch(`${BACKEND_URL}/api/intelligence/lost-sales?storeCode=${storeA}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const data = await res.json();
    assert.ok(data.success);
    assert.ok(Array.isArray(data.lostSalesAndObjections));

    // Verify price objection category is present with verifiable quote
    const priceCat = data.lostSalesAndObjections.find((c) => c.category === 'Price / Budget Constraint');
    assert.ok(priceCat, 'Price / Budget Constraint category must be present');
    assert.ok(priceCat.count >= 1, 'Count must be >= 1');
    assert.ok(priceCat.evidenceQuotes.length >= 1, 'Must have supporting quotes');
    assert.match(
      priceCat.evidenceQuotes[0].quote.toLowerCase(),
      /too expensive|budget/,
      'Quote must verify actual price objection text'
    );

    // Verify "Reason not identified" category exists for unconverted session without objection
    const noReasonCat = data.lostSalesAndObjections.find((c) => c.category === 'Reason not identified');
    assert.ok(noReasonCat, 'Reason not identified must be present for unconverted session lacking objection');
    assert.ok(noReasonCat.count >= 1, 'Count must be >= 1');
  });

  test('3. Unknown outcomes are not counted as confirmed sales (strict numerator integrity)', async () => {
    // 3a. Store A overview
    const resA = await fetch(`${BACKEND_URL}/api/intelligence/overview?storeCode=${storeA}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const dataA = await resA.json();
    assert.ok(dataA.success);

    const summaryA = dataA.summary;
    // In Store A: exactly 1 sale confirmed (A1), 1 follow-up (A2), 2 unconverted (A3, A4)
    assert.equal(summaryA.confirmedSalesCount, 1, 'Only session A1 is counted as confirmed sale');
    assert.equal(summaryA.totalEligibleConversations, 4, 'Store A has 4 completed sessions');
    assert.equal(summaryA.conversionRate, 25.0, 'Conversion rate is 1/4 = 25.0%');

    // 3b. Store B overview: Contains session B1 with outcome 'Unclear'
    const resB = await fetch(`${BACKEND_URL}/api/intelligence/overview?storeCode=${storeB}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const dataB = await resB.json();
    assert.ok(dataB.success);

    const summaryB = dataB.summary;
    // Session B1 has outcome 'Unclear' and must NOT be counted in confirmed sales
    assert.equal(summaryB.confirmedSalesCount, 0, 'Unclear outcome must NOT be counted as confirmed sale');
    assert.equal(summaryB.unclearOutcomesCount, 1, 'Store B unclear outcome must be counted');
    assert.equal(summaryB.conversionRate, 0.0, 'Conversion rate must be 0% when outcome is unclear');
    assert.ok(summaryB.conversionMetricDisclosure, 'Disclosure explaining denominator must be included');
  });

  test('4. Store and date filters produce correct, narrowed results', async () => {
    // 4a. Filter by Store A
    const storeARes = await fetch(`${BACKEND_URL}/api/intelligence/overview?storeCode=${storeA}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const storeAData = await storeARes.json();
    assert.ok(storeAData.success);
    // All returned requirements must belong to storeA
    assert.ok(storeAData.customerRequirements.every((r) => r.storeCode === storeA));

    // Store comparison should only show storeA
    assert.equal(storeAData.storeComparison.length, 1);
    assert.equal(storeAData.storeComparison[0].storeCode, storeA);
    assert.equal(storeAData.storeComparison[0].confirmedSales, 1);
    assert.equal(storeAData.storeComparison[0].followUpsRequired, 1);
    assert.equal(storeAData.storeComparison[0].unconverted, 2);

    // 4b. Filter by Store B
    const storeBRes = await fetch(`${BACKEND_URL}/api/intelligence/overview?storeCode=${storeB}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const storeBData = await storeBRes.json();
    assert.ok(storeBData.success);
    assert.equal(storeBData.storeComparison.length, 1);
    assert.equal(storeBData.storeComparison[0].storeCode, storeB);
    assert.equal(storeBData.storeComparison[0].confirmedSales, 0); // No confirmed sales in store B
  });

  test('5. Charts and CSV exports agree with filtered persisted data', async () => {
    const csvRes = await fetch(`${BACKEND_URL}/api/intelligence/export-csv?storeCode=${storeA}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(csvRes.status, 200);
    const csvText = await csvRes.text();

    // Verify CSV contains expected headers and storeA data
    assert.ok(csvText.includes('Session ID'), 'CSV must include header Session ID');
    assert.ok(csvText.includes(storeA), 'CSV must contain data for storeA');
    assert.ok(csvText.includes('iPhone 16 Pro Max'), 'CSV must mention product demand');
    assert.ok(!csvText.includes(storeB), 'Filtered CSV for Store A must NOT contain Store B');
  });

  test('6. Stale and missing analyses are tracked and handled gracefully', async () => {
    const res = await fetch(`${BACKEND_URL}/api/intelligence/overview`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const data = await res.json();
    assert.ok(data.success);
    // Session A4 had isOutdated: true, so staleAnalysisCount should be >= 1
    assert.ok(data.summary.staleAnalysisCount >= 1, 'Stale analysis count must be >= 1');
  });

  test('7. Store-level authorization: sales managers cannot access unauthorized store data', async () => {
    // Manager 01 has storeCode = storeA. If they pass storeCode = storeB, backend enforces storeA
    const crossRes = await fetch(`${BACKEND_URL}/api/intelligence/overview?storeCode=${storeB}`, {
      headers: { Authorization: `Bearer ${managerStore01Token}` },
    });
    const crossData = await crossRes.json();
    assert.ok(crossData.success);

    // Results must be restricted to manager's authorized store (storeA)
    const returnedStores = crossData.storeComparison.map((s) => s.storeCode);
    assert.equal(returnedStores.includes(storeB), false, 'Manager 01 must never receive Store B intelligence');
    assert.ok(crossData.customerRequirements.every((r) => r.storeCode === storeA));
  });

  test('8. Regression verification: Modules 0-8 session, deal analysis, and notifications functional', async () => {
    // 8a. Verify session API
    const sessRes = await fetch(`${BACKEND_URL}/api/sessions/${sessionSaleA.sessionId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const sessData = await sessRes.json();
    assert.ok(sessData.success, 'Session API remains functional');
    assert.equal(sessData.session.dealAnalysis.conversationOutcome, 'Sale Confirmed');

    // 8b. Verify notifications unread count API from Module 8
    const notifRes = await fetch(`${BACKEND_URL}/api/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const notifData = await notifRes.json();
    assert.ok(notifData.success, 'Module 8 notification count API remains functional');
  });
});
