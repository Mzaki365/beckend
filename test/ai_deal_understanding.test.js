const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const dealAnalysisService = require('../services/dealAnalysisService');
const dailyReportService = require('../services/dailyReportService');
const Session = require('../models/Session');
const DailyReport = require('../models/DailyReport');

const TEST_MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://sarfrazafzal790_db_user:uf5VWKdvIil4yXUS@storelistener.sy7em7l.mongodb.net/storelistener?retryWrites=true&w=majority&appName=Storelistener';

describe('StoreListener — AI Deal Understanding & Negotiated Revenue (12 Mandatory Tests)', () => {
  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_MONGO_URI);
    }
  });

  after(async () => {
    // Clean up test sessions
    await Session.deleteMany({ sessionId: { $regex: /^test_deal_/ } });
    await DailyReport.deleteMany({ reportKey: { $regex: /^test_deal_/ } });
  });

  // TEST 1: Asking price $25; customer offers $15; agent accepts; customer says “pack it” → accepted deal, agreed value $15
  test('Test 1: Asking price $25; customer offers $15; agent accepts; customer says "pack it" -> accepted deal, agreed value $15', async () => {
    const transcripts = [
      { speaker: 'sales_rep', text: 'The iPhone costs $25.' },
      { speaker: 'customer', text: "I'll pay $15." },
      { speaker: 'sales_rep', text: 'Okay, $15.' },
      { speaker: 'customer', text: 'Pack it.' },
    ];

    const result = dealAnalysisService.analyzeDealNegotiation(transcripts);
    assert.strictEqual(result.dealStatus, 'accepted');
    assert.strictEqual(result.salesOutcome, 'Won');
    assert.strictEqual(result.finalAgreedPrice, 15);
    assert.strictEqual(result.agreedDealValue, 15);
    assert.strictEqual(result.realizedRevenue, 15);
    assert.notStrictEqual(result.agreedDealValue, 25, 'Must not count initial asking price of $25');
    assert.notStrictEqual(result.agreedDealValue, 40, 'Must not sum both $25 and $15');
    assert.strictEqual(result.isMissedOpportunity, false);
  });

  // TEST 2: Asking price $25; customer accepts → accepted deal, agreed value $25
  test('Test 2: Asking price $25; customer accepts without negotiation -> accepted deal, agreed value $25', async () => {
    const transcripts = [
      { speaker: 'sales_rep', text: 'The charger costs $25.' },
      { speaker: 'customer', text: 'Okay, pack it.' },
    ];

    const result = dealAnalysisService.analyzeDealNegotiation(transcripts);
    assert.strictEqual(result.dealStatus, 'accepted');
    assert.strictEqual(result.salesOutcome, 'Won');
    assert.strictEqual(result.finalAgreedPrice, 25);
    assert.strictEqual(result.agreedDealValue, 25);
    assert.strictEqual(result.realizedRevenue, 25);
    assert.strictEqual(result.isMissedOpportunity, false);
  });

  // TEST 3: Customer offers $15; agent refuses; customer leaves → lost, revenue $0
  test('Test 3: Customer offers $15; agent refuses; customer leaves -> lost, revenue $0, missed opportunity price disagreement', async () => {
    const transcripts = [
      { speaker: 'sales_rep', text: 'The iPhone costs $25.' },
      { speaker: 'customer', text: "I'll pay $15." },
      { speaker: 'sales_rep', text: 'Sorry, the minimum price is $20.' },
      { speaker: 'customer', text: "No, I don't want it." },
    ];

    const result = dealAnalysisService.analyzeDealNegotiation(transcripts);
    assert.strictEqual(result.dealStatus, 'lost');
    assert.strictEqual(result.salesOutcome, 'Lost');
    assert.strictEqual(result.agreedDealValue, 0);
    assert.strictEqual(result.realizedRevenue, 0);
    assert.strictEqual(result.isMissedOpportunity, true);
    assert.strictEqual(result.missedOpportunityReason, 'price_disagreement');
  });

  // TEST 4: Customer rejects the product → lost, revenue $0
  test('Test 4: Customer rejects the product -> lost, revenue $0, missed opportunity customer rejection', async () => {
    const transcripts = [
      { speaker: 'sales_rep', text: 'The charger costs $25.' },
      { speaker: 'customer', text: "I don't want it." },
    ];

    const result = dealAnalysisService.analyzeDealNegotiation(transcripts);
    assert.strictEqual(result.dealStatus, 'lost');
    assert.strictEqual(result.salesOutcome, 'Lost');
    assert.strictEqual(result.agreedDealValue, 0);
    assert.strictEqual(result.realizedRevenue, 0);
    assert.strictEqual(result.isMissedOpportunity, true);
    assert.strictEqual(result.missedOpportunityReason, 'customer_rejection');
  });

  // TEST 5: Agent accepts $15 but customer says “I’ll think about it” → pending, revenue $0
  test('Test 5: Agent accepts $15 but customer says "I\'ll think about it" -> pending, revenue $0', async () => {
    const transcripts = [
      { speaker: 'sales_rep', text: 'The iPhone costs $25.' },
      { speaker: 'customer', text: 'Can you do $15?' },
      { speaker: 'sales_rep', text: 'Yes, $15.' },
      { speaker: 'customer', text: "I'll think about it." },
    ];

    const result = dealAnalysisService.analyzeDealNegotiation(transcripts);
    assert.strictEqual(result.dealStatus, 'pending');
    assert.strictEqual(result.salesOutcome, 'Pending');
    assert.strictEqual(result.agreedDealValue, 0);
    assert.strictEqual(result.realizedRevenue, 0);
    assert.strictEqual(result.customerCommitted, false);
    assert.strictEqual(result.isMissedOpportunity, false);
  });

  // TEST 6: Customer accepts but price is unclear → price unverified, no invented revenue
  test('Test 6: Customer accepts but price is unclear -> price unverified, no invented revenue', async () => {
    const transcripts = [
      { speaker: 'customer', text: 'I really love this phone, pack it up for me.' },
      { speaker: 'sales_rep', text: 'Great, I will get the brand new box from the back.' },
    ];

    const result = dealAnalysisService.analyzeDealNegotiation(transcripts);
    assert.strictEqual(result.dealStatus, 'accepted');
    assert.strictEqual(result.isPriceVerified, false);
    assert.strictEqual(result.finalAgreedPrice, null);
    assert.strictEqual(result.agreedDealValue, null);
    assert.strictEqual(result.realizedRevenue, null);
    assert.ok(result.reviewFlags.includes('unverified_price'));
  });

  // TEST 7: Two products purchased with distinct prices → correct supported total
  test('Test 7: Two products purchased with distinct prices -> correct supported total without double-counting', async () => {
    const transcripts = [
      { speaker: 'sales_rep', text: 'The iPhone is $20 and the charger is $5.' },
      { speaker: 'customer', text: 'Okay, pack them both.' },
    ];

    const result = dealAnalysisService.analyzeDealNegotiation(transcripts);
    assert.strictEqual(result.dealStatus, 'accepted');
    assert.strictEqual(result.salesOutcome, 'Won');
    assert.strictEqual(result.finalAgreedPrice, 25);
    assert.strictEqual(result.agreedDealValue, 25);
    assert.strictEqual(result.realizedRevenue, 25);
    assert.strictEqual(result.products.length, 2);
  });

  // TEST 8: Multiple price offers before the final agreement → only the final mutually agreed price counts
  test('Test 8: Multiple price offers before final agreement -> only final mutually agreed price counts', async () => {
    const transcripts = [
      { speaker: 'sales_rep', text: 'The iPhone costs $50.' },
      { speaker: 'customer', text: 'How about $30?' },
      { speaker: 'sales_rep', text: 'No, lowest is $40.' },
      { speaker: 'customer', text: 'Can you do $35?' },
      { speaker: 'sales_rep', text: 'Okay, $35.' },
      { speaker: 'customer', text: 'Pack it.' },
    ];

    const result = dealAnalysisService.analyzeDealNegotiation(transcripts);
    assert.strictEqual(result.dealStatus, 'accepted');
    assert.strictEqual(result.finalAgreedPrice, 35);
    assert.strictEqual(result.agreedDealValue, 35);
    assert.strictEqual(result.realizedRevenue, 35);
    assert.notStrictEqual(result.agreedDealValue, 50);
    assert.notStrictEqual(result.agreedDealValue, 40);
    assert.notStrictEqual(result.agreedDealValue, 30);
  });

  // TEST 9: Customer withdraws acceptance → do not retain the withdrawn deal as accepted
  test('Test 9: Customer withdraws acceptance -> deal marked lost, revenue $0', async () => {
    const transcripts = [
      { speaker: 'sales_rep', text: 'The iPhone is $25.' },
      { speaker: 'customer', text: 'Okay, pack it.' },
      { speaker: 'customer', text: 'Wait, actually never mind, cancel that, I cannot afford this right now.' },
      { speaker: 'sales_rep', text: 'No problem, have a good day.' },
    ];

    const result = dealAnalysisService.analyzeDealNegotiation(transcripts);
    assert.strictEqual(result.dealStatus, 'lost');
    assert.strictEqual(result.salesOutcome, 'Lost');
    assert.strictEqual(result.agreedDealValue, 0);
    assert.strictEqual(result.realizedRevenue, 0);
    assert.strictEqual(result.isMissedOpportunity, true);
  });

  // TEST 10: Ambiguous transcript → unknown/review, no fabricated revenue
  test('Test 10: Ambiguous transcript -> unknown/no_opportunity, no fabricated revenue', async () => {
    const transcripts = [
      { speaker: 'customer', text: 'Hello, nice weather today.' },
      { speaker: 'sales_rep', text: 'Yes, it is very nice outside.' },
      { speaker: 'customer', text: 'Thanks, bye.' },
    ];

    const result = dealAnalysisService.analyzeDealNegotiation(transcripts);
    assert.ok(['unknown', 'no_opportunity'].includes(result.dealStatus));
    assert.strictEqual(result.agreedDealValue, 0);
    assert.strictEqual(result.realizedRevenue, 0);
  });

  // TEST 11: Re-running analysis → no duplicate sales or double-counted revenue
  test('Test 11: Re-running analysis -> idempotent results without duplicates', async () => {
    const sessionId = `test_deal_idempotent_${Date.now()}`;
    const session = await Session.create({
      sessionId,
      storeCode: 'STORE-01',
      status: 'completed',
      startedAt: new Date(),
      transcripts: [
        { speaker: 'sales_rep', text: 'The iPhone costs $25.' },
        { speaker: 'customer', text: "I'll pay $15." },
        { speaker: 'sales_rep', text: 'Okay, $15.' },
        { speaker: 'customer', text: 'Pack it.' },
      ],
    });

    const run1 = await dealAnalysisService.runAnalysisForSession(sessionId, { force: true });
    assert.strictEqual(run1.salesOutcome, 'Won');
    assert.strictEqual(run1.finalAgreedPrice, 15);
    assert.strictEqual(run1.agreedDealValue, 15);

    // Re-run immediately
    const run2 = await dealAnalysisService.runAnalysisForSession(sessionId, { force: true });
    assert.strictEqual(run2.salesOutcome, 'Won');
    assert.strictEqual(run2.finalAgreedPrice, 15);
    assert.strictEqual(run2.agreedDealValue, 15);

    const docCount = await Session.countDocuments({ sessionId });
    assert.strictEqual(docCount, 1, 'Must remain exactly 1 document in database');
  });

  // TEST 12: Daily totals → match validated per-conversation records and actual transaction records
  test('Test 12: Daily totals match validated per-conversation records and actual transaction records', async () => {
    const dateStr = '2027-01-15'; // Future test date to avoid touching production data
    const s1Id = `test_deal_daily_s1_${Date.now()}`;
    const s2Id = `test_deal_daily_s2_${Date.now()}`;
    const s3Id = `test_deal_daily_s3_${Date.now()}`;

    // s1: Accepted $15
    await Session.create({
      sessionId: s1Id,
      storeCode: 'STORE-01',
      status: 'completed',
      startedAt: new Date(`${dateStr}T10:00:00Z`),
      transcripts: [
        { speaker: 'sales_rep', text: 'The iPhone costs $25.' },
        { speaker: 'customer', text: "I'll pay $15." },
        { speaker: 'sales_rep', text: 'Okay, $15.' },
        { speaker: 'customer', text: 'Pack it.' },
      ],
    });

    // s2: Accepted $25
    await Session.create({
      sessionId: s2Id,
      storeCode: 'STORE-02',
      status: 'completed',
      startedAt: new Date(`${dateStr}T11:00:00Z`),
      transcripts: [
        { speaker: 'sales_rep', text: 'The charger costs $25.' },
        { speaker: 'customer', text: 'Okay, pack it.' },
      ],
    });

    // s3: Lost $0
    await Session.create({
      sessionId: s3Id,
      storeCode: 'STORE-01',
      status: 'completed',
      startedAt: new Date(`${dateStr}T12:00:00Z`),
      transcripts: [
        { speaker: 'sales_rep', text: 'The charger costs $25.' },
        { speaker: 'customer', text: "I don't want it." },
      ],
    });

    // Run analysis for all 3 sessions
    await dealAnalysisService.runAnalysisForSession(s1Id, { force: true });
    await dealAnalysisService.runAnalysisForSession(s2Id, { force: true });
    await dealAnalysisService.runAnalysisForSession(s3Id, { force: true });

    // Generate daily report for date
    const report = await dailyReportService.generateOrUpdateDailyReport({
      date: dateStr,
      store: 'all',
      refresh: true,
    });

    assert.strictEqual(report.conversationsCount, 3);
    assert.strictEqual(report.metrics.wonCount, 2);
    assert.strictEqual(report.metrics.lostCount, 1);
    assert.strictEqual(report.metrics.totalAgreedSalesValue, 40); // 15 + 25 = 40
    assert.strictEqual(report.metrics.verifiedRevenueDisplay, '$40');

    // Store breakdown check
    const store1 = report.storeBreakdown.find((s) => s.storeCode === 'STORE-01');
    const store2 = report.storeBreakdown.find((s) => s.storeCode === 'STORE-02');
    assert.ok(store1, 'STORE-01 exists in breakdown');
    assert.ok(store2, 'STORE-02 exists in breakdown');
    assert.strictEqual(store1.totalConversations, 2);
    assert.strictEqual(store1.wonCount, 1);
    assert.strictEqual(store1.verifiedRevenue, 15);
    assert.strictEqual(store2.totalConversations, 1);
    assert.strictEqual(store2.wonCount, 1);
    assert.strictEqual(store2.verifiedRevenue, 25);
  });
});
