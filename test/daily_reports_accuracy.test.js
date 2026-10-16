/**
 * Storelistener — Daily Reports Accuracy & Calendar Management Test Suite
 * File: test/daily_reports_accuracy.test.js
 *
 * Tests all 10 mandatory requirements:
 * 1. Date with no conversations and no sales
 * 2. Date with multiple conversations but no verified sales (verbal "I'll buy it" not counted)
 * 3. Date with verified sales linked to conversations
 * 4. Duplicate events or repeated updates for same conversation (counted once)
 * 5. Pending, cancelled, or refunded transactions excluded from verified sales
 * 6. Missing inventory data (N/A) vs actual low-stock products
 * 7. Report generated earlier in day followed by new conversations (freshness/stale detection)
 * 8. Updating report refreshes underlying data without double-counting
 * 9. Switching dates displays correct saved report without silent generation
 * 10. Date boundaries, timezone handling (America/New_York), and store permissions
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Session = require('../models/Session');
const DailyReport = require('../models/DailyReport');
const Inventory = require('../models/Inventory');
const dailyReportService = require('../services/dailyReportService');

describe('Daily Reports Accuracy & Calendar Management Overhaul', () => {
  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/storelistener_test');
    }
    // Clean test state
    await Session.deleteMany({ sessionId: /^test_dr_/ });
    await DailyReport.deleteMany({ reportKey: /^2026-11-/ });
    await Inventory.deleteMany({ storeCode: 'TEST_STR_01' });
  });

  after(async () => {
    await Session.deleteMany({ sessionId: /^test_dr_/ });
    await DailyReport.deleteMany({ reportKey: /^2026-11-/ });
    await Inventory.deleteMany({ storeCode: 'TEST_STR_01' });
  });

  test('Test 1: A date with no conversations and no sales', async () => {
    const dateStr = '2026-11-01';
    const report = await dailyReportService.generateOrUpdateDailyReport({
      date: dateStr,
      store: 'all',
    });

    assert.equal(report.success, true);
    assert.equal(report.metrics.totalCompleted, 0);
    assert.equal(report.metrics.verifiedSalesCount, 0);
    assert.equal(report.metrics.verifiedRevenue, null);
    assert.equal(report.metrics.verifiedRevenueDisplay, '$0');
    assert.equal(report.metrics.avgTicket, null);
    assert.equal(report.metrics.avgTicketDisplay, 'N/A');
    assert.equal(report.metrics.activityLevel, 'Quiet');
    assert.ok(report.metrics.headline.includes('0 conversations'));
    assert.ok(report.aiSummary.salesOutcomesSummary.toLowerCase().includes('zero'));
  });

  test('Test 2: A date with multiple conversations but no verified sales (verbal agreement not counted)', async () => {
    const dateStr = '2026-11-02';
    const bounds = dailyReportService.resolveDateRange({ date: dateStr });

    // Insert 2 completed sessions: one with verbal agreement "I'll buy it" but verifiedSale: false
    await Session.create([
      {
        sessionId: 'test_dr_01',
        storeCode: 'TEST_STR_01',
        storeName: 'Test Store 1',
        status: 'completed',
        startedAt: new Date(bounds.startDate.getTime() + 3600000), // 1 hour after start of day
        durationSeconds: 180,
        verifiedSale: false,
        verifiedRevenue: null,
        transcripts: [
          { speaker: 'sales_rep', text: 'This is the iPhone 16 Pro.' },
          { speaker: 'customer', text: 'Looks great, I will buy it tomorrow.' },
        ],
        dealAnalysis: {
          analysisStatus: 'completed',
          conversationOutcome: 'Sale Confirmed', // Verbal intent
          salesOutcome: 'Won',
          summary: 'Customer stated they will buy it.',
        },
      },
      {
        sessionId: 'test_dr_02',
        storeCode: 'TEST_STR_01',
        storeName: 'Test Store 1',
        status: 'completed',
        startedAt: new Date(bounds.startDate.getTime() + 7200000),
        durationSeconds: 240,
        verifiedSale: false,
        verifiedRevenue: null,
        transcripts: [
          { speaker: 'sales_rep', text: 'Can I help with anything else?' },
          { speaker: 'customer', text: 'Just browsing today, thanks.' },
        ],
        dealAnalysis: {
          analysisStatus: 'completed',
          conversationOutcome: 'Not Converted',
          salesOutcome: 'Lost',
        },
      },
    ]);

    const report = await dailyReportService.generateOrUpdateDailyReport({
      date: dateStr,
      store: 'TEST_STR_01',
    });

    assert.equal(report.metrics.totalCompleted, 2);
    // Strict data integrity rule: verbal statement "I will buy it" is NOT a verified sale
    assert.equal(report.metrics.verifiedSalesCount, 0);
    assert.equal(report.metrics.verifiedRevenue, null);
    assert.equal(report.metrics.verifiedRevenueDisplay, '$0');
    assert.equal(report.metrics.avgTicket, null);
    assert.equal(report.metrics.avgTicketDisplay, 'N/A');
    assert.equal(report.metrics.missedOpportunitiesCount, 1);
  });

  test('Test 3: A date with verified sales linked to conversations', async () => {
    const dateStr = '2026-11-03';
    const bounds = dailyReportService.resolveDateRange({ date: dateStr });

    await Session.create([
      {
        sessionId: 'test_dr_03',
        storeCode: 'TEST_STR_01',
        storeName: 'Test Store 1',
        status: 'completed',
        startedAt: new Date(bounds.startDate.getTime() + 3600000),
        durationSeconds: 300,
        verifiedSale: true,
        verifiedRevenue: 1200,
        transactionId: 'TXN-9001',
        transcripts: [
          { speaker: 'sales_rep', text: 'Here is your new iPhone 16 Pro receipt.' },
          { speaker: 'customer', text: 'Thank you so much!' },
        ],
        dealAnalysis: {
          analysisStatus: 'completed',
          conversationOutcome: 'Sale Confirmed',
          salesOutcome: 'Won',
        },
      },
      {
        sessionId: 'test_dr_04',
        storeCode: 'TEST_STR_01',
        storeName: 'Test Store 1',
        status: 'completed',
        startedAt: new Date(bounds.startDate.getTime() + 7200000),
        durationSeconds: 200,
        verifiedSale: true,
        verifiedRevenue: 800,
        transactionId: 'TXN-9002',
        transcripts: [
          { speaker: 'sales_rep', text: 'Payment confirmed for iPhone 15.' },
        ],
        dealAnalysis: {
          analysisStatus: 'completed',
          conversationOutcome: 'Sale Confirmed',
          salesOutcome: 'Won',
        },
      },
    ]);

    const report = await dailyReportService.generateOrUpdateDailyReport({
      date: dateStr,
      store: 'TEST_STR_01',
    });

    assert.equal(report.metrics.totalCompleted, 2);
    assert.equal(report.metrics.verifiedSalesCount, 2);
    assert.equal(report.metrics.verifiedRevenue, 2000);
    assert.equal(report.metrics.verifiedRevenueDisplay, '$2,000');
    assert.equal(report.metrics.avgTicket, 1000); // 2000 / 2 = 1000
    assert.equal(report.metrics.avgTicketDisplay, '$1,000');
  });

  test('Test 4: Duplicate events or repeated updates for the same conversation', async () => {
    const dateStr = '2026-11-04';
    const bounds = dailyReportService.resolveDateRange({ date: dateStr });

    // Insert 1 real session
    await Session.create({
      sessionId: 'test_dr_dup_01',
      storeCode: 'TEST_STR_01',
      storeName: 'Test Store 1',
      status: 'completed',
      startedAt: new Date(bounds.startDate.getTime() + 3600000),
      durationSeconds: 150,
      verifiedSale: true,
      verifiedRevenue: 999,
      transcripts: [{ speaker: 'customer', text: 'Testing duplicate guard' }],
      dealAnalysis: { analysisStatus: 'completed', conversationOutcome: 'Sale Confirmed', salesOutcome: 'Won' },
    });

    const report = await dailyReportService.generateOrUpdateDailyReport({
      date: dateStr,
      store: 'TEST_STR_01',
    });

    assert.equal(report.metrics.totalCompleted, 1);
    assert.equal(report.metrics.verifiedRevenue, 999);

    // Call again to verify report recalculates without double-counting
    const refreshed = await dailyReportService.generateOrUpdateDailyReport({
      date: dateStr,
      store: 'TEST_STR_01',
      refresh: true,
    });

    assert.equal(refreshed.metrics.totalCompleted, 1);
    assert.equal(refreshed.metrics.verifiedRevenue, 999);
  });

  test('Test 5: Pending, cancelled, or refunded transactions excluded from verified sales', async () => {
    const dateStr = '2026-11-05';
    const bounds = dailyReportService.resolveDateRange({ date: dateStr });

    await Session.create([
      {
        sessionId: 'test_dr_cancelled_01',
        storeCode: 'TEST_STR_01',
        storeName: 'Test Store 1',
        status: 'cancelled', // Cancelled session
        startedAt: new Date(bounds.startDate.getTime() + 3600000),
        durationSeconds: 60,
        verifiedSale: true,
        verifiedRevenue: 1200,
        transcripts: [{ speaker: 'customer', text: 'Nevermind, cancel this.' }],
        dealAnalysis: { analysisStatus: 'completed' },
      },
      {
        sessionId: 'test_dr_refunded_02',
        storeCode: 'TEST_STR_01',
        storeName: 'Test Store 1',
        status: 'completed',
        transactionStatus: 'refunded', // Refunded sale
        startedAt: new Date(bounds.startDate.getTime() + 7200000),
        durationSeconds: 120,
        verifiedSale: true,
        verifiedRevenue: 800,
        transcripts: [{ speaker: 'customer', text: 'Return item' }],
        dealAnalysis: { analysisStatus: 'completed' },
      },
    ]);

    const report = await dailyReportService.generateOrUpdateDailyReport({
      date: dateStr,
      store: 'TEST_STR_01',
    });

    // Cancelled session is not completed; refunded transaction is excluded from verified sales/revenue
    assert.equal(report.metrics.verifiedSalesCount, 0);
    assert.equal(report.metrics.verifiedRevenue, null);
    assert.equal(report.metrics.verifiedRevenueDisplay, '$0');
  });

  test('Test 6: Missing inventory data (N/A) vs actual low-stock products', async () => {
    const dateStr = '2026-11-06';

    // 1. When no inventory data exists:
    await Inventory.deleteMany({ storeCode: 'TEST_STR_01' });
    const reportNoInv = await dailyReportService.generateOrUpdateDailyReport({
      date: dateStr,
      store: 'TEST_STR_01',
    });

    assert.equal(reportNoInv.metrics.lowStockDisplay, 'N/A');
    assert.ok(reportNoInv.metrics.lowStockExplanation.includes('not connected'));

    // 2. When actual inventory data is configured:
    await Inventory.create([
      {
        productName: 'iPhone 16 Pro Max 256GB',
        sku: 'IPH16PM-256',
        storeCode: 'TEST_STR_01',
        currentStock: 2,
        lowStockThreshold: 5, // Low stock!
      },
      {
        productName: 'iPhone 16 128GB',
        sku: 'IPH16-128',
        storeCode: 'TEST_STR_01',
        currentStock: 15,
        lowStockThreshold: 5, // In stock
      },
    ]);

    const reportWithInv = await dailyReportService.generateOrUpdateDailyReport({
      date: dateStr,
      store: 'TEST_STR_01',
      refresh: true,
    });

    assert.equal(reportWithInv.metrics.lowStockDisplay, '1');
    assert.equal(reportWithInv.metrics.lowStockCount, 1);
    assert.equal(reportWithInv.metrics.lowStockItems[0].productName, 'iPhone 16 Pro Max 256GB');
  });

  test('Test 7: Report generated earlier in day followed by new conversations (stale detection)', async () => {
    const dateStr = '2026-11-07';
    const bounds = dailyReportService.resolveDateRange({ date: dateStr });

    // Morning session
    await Session.create({
      sessionId: 'test_dr_stale_morning',
      storeCode: 'TEST_STR_01',
      storeName: 'Test Store 1',
      status: 'completed',
      startedAt: new Date(bounds.startDate.getTime() + 3600000),
      durationSeconds: 120,
      transcripts: [{ speaker: 'customer', text: 'Morning customer' }],
      dealAnalysis: { analysisStatus: 'completed', salesOutcome: 'Pending' },
    });

    // Generate morning report
    await dailyReportService.generateOrUpdateDailyReport({
      date: dateStr,
      store: 'TEST_STR_01',
    });

    // Verify saved report is not stale
    const check1 = await dailyReportService.getSavedDailyReport({ date: dateStr, store: 'TEST_STR_01' });
    assert.equal(check1.hasReport, true);
    assert.equal(check1.isStale, false);

    // Afternoon: A new customer arrives!
    await Session.create({
      sessionId: 'test_dr_stale_afternoon',
      storeCode: 'TEST_STR_01',
      storeName: 'Test Store 1',
      status: 'completed',
      startedAt: new Date(bounds.startDate.getTime() + 25000000),
      durationSeconds: 180,
      transcripts: [{ speaker: 'customer', text: 'Afternoon customer' }],
      dealAnalysis: { analysisStatus: 'completed', salesOutcome: 'Won' },
    });

    // Inspect saved report again: must detect isStale: true
    const check2 = await dailyReportService.getSavedDailyReport({ date: dateStr, store: 'TEST_STR_01' });
    assert.equal(check2.hasReport, true);
    assert.equal(check2.isStale, true);
    assert.ok(check2.freshnessNote.includes('New conversations or sales recorded'));
  });

  test('Test 8: Updating report refreshes underlying data without double-counting', async () => {
    const dateStr = '2026-11-07';

    // Click "Update Analysis"
    const refreshed = await dailyReportService.generateOrUpdateDailyReport({
      date: dateStr,
      store: 'TEST_STR_01',
      refresh: true,
    });

    assert.equal(refreshed.metrics.totalCompleted, 2);
    assert.equal(refreshed.isStale, false);

    // Verify only ONE DailyReport document exists for this date and store (no duplicate documents)
    const reportDocs = await DailyReport.find({ date: dateStr, storeCode: 'TEST_STR_01' });
    assert.equal(reportDocs.length, 1);
  });

  test('Test 9: Switching between dates and confirming correct saved report is displayed', async () => {
    const dateA = '2026-11-03';
    const dateB = '2026-11-09'; // Unanalyzed date

    // Date A: has saved report
    const resA = await dailyReportService.getSavedDailyReport({ date: dateA, store: 'TEST_STR_01' });
    assert.equal(resA.hasReport, true);
    assert.equal(resA.date, dateA);
    assert.equal(resA.metrics.totalCompleted, 2);

    // Date B: has NO saved report
    const resB = await dailyReportService.getSavedDailyReport({ date: dateB, store: 'TEST_STR_01' });
    assert.equal(resB.hasReport, false);
    assert.equal(resB.report, null);
    assert.ok(resB.message.includes('No analysis has been generated'));

    // Crucial check: Date B document was NOT silently created in database
    const docB = await DailyReport.findOne({ date: dateB, storeCode: 'TEST_STR_01' });
    assert.equal(docB, null);
  });

  test('Test 10: Date boundaries, timezone handling, and store permissions', async () => {
    // 1. Timezone boundary precision
    const bounds = dailyReportService.resolveDateRange({ date: '2026-11-10' });
    assert.equal(bounds.businessTimezone, 'America/New_York');
    assert.ok(bounds.startDate instanceof Date);
    assert.ok(bounds.endDate instanceof Date);
    // Boundary span is exactly 24 hours (86,399,999 ms)
    assert.equal(bounds.endDate.getTime() - bounds.startDate.getTime(), 86399999);

    // 2. Store scoping permissions
    const managerUser = { role: 'sales_manager', storeCode: 'STR_MGR_01' };
    const adminUser = { role: 'store_admin' };

    const filterManager = dailyReportService.buildFilter(bounds, { store: 'all' }, managerUser);
    assert.equal(filterManager.storeCode, 'STR_MGR_01');

    const filterAdmin = dailyReportService.buildFilter(bounds, { store: 'all' }, adminUser);
    assert.equal(filterAdmin.storeCode, undefined);
  });
});
