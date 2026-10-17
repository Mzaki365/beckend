/**
 * Storelistener — Daily Report & AI Daily Summary Model (Task 2)
 * File: models/DailyReport.js
 *
 * Persists date-level and range-level summaries, verified sales analytics,
 * AI synthesized observations, and conversation report associations.
 */

const mongoose = require('mongoose');

const DailyReportSchema = new mongoose.Schema({
  reportKey: {
    type: String, // e.g. "2026-10-14:all:all:newest"
    required: true,
    unique: true,
    index: true,
  },
  reportType: {
    type: String,
    enum: ['single_day', 'custom_range'],
    default: 'single_day',
  },
  date: {
    type: String, // "YYYY-MM-DD"
    required: true,
    index: true,
  },
  startDate: {
    type: Date,
  },
  endDate: {
    type: Date,
  },
  storeCode: {
    type: String,
    default: 'all',
  },
  storeName: {
    type: String,
    default: 'All Retail Branches',
  },
  salesperson: {
    type: String,
    default: 'all',
  },
  businessTimezone: {
    type: String,
    default: 'America/New_York',
  },
  metrics: {
    totalCompleted: { type: Number, default: 0 },
    completedAnalysisCount: { type: Number, default: 0 },
    pendingAnalysisCount: { type: Number, default: 0 },
    failedAnalysisCount: { type: Number, default: 0 },
    wonCount: { type: Number, default: 0 },
    lostCount: { type: Number, default: 0 },
    pendingCount: { type: Number, default: 0 },
    inconclusiveCount: { type: Number, default: 0 },
    verifiedSalesCount: { type: Number, default: 0 },
    verifiedRevenue: { type: Number, default: null }, // null = not verified / unavailable
    verifiedRevenueDisplay: { type: String, default: '$0' },
    avgTicket: { type: Number, default: null },
    avgTicketDisplay: { type: String, default: 'N/A' },
    missedOpportunitiesCount: { type: Number, default: 0 },
    missedOpportunitiesDisplay: { type: String, default: 'N/A' },
    missedOpportunitiesExplanation: { type: String, default: '' },
    lowStockCount: { type: Number, default: null },
    lowStockDisplay: { type: String, default: 'N/A' },
    lowStockExplanation: { type: String, default: '' },
    lowStockItems: [{ type: mongoose.Schema.Types.Mixed }],
    activityLevel: { type: String, default: 'Quiet' },
    headline: { type: String, default: '' },
    headlineExplanation: { type: String, default: '' },
    totalWordCount: { type: Number, default: 0 },
    totalDurationSeconds: { type: Number, default: 0 },
    insufficientEvidenceCount: { type: Number, default: 0 },
    conversionRate: { type: Number, default: 0 },
    followUpRate: { type: Number, default: 0 },
  },
  dailyTrends: [{
    date: { type: String },
    total: { type: Number, default: 0 },
    won: { type: Number, default: 0 },
    lost: { type: Number, default: 0 },
    pending: { type: Number, default: 0 },
    inconclusive: { type: Number, default: 0 },
    verifiedSales: { type: Number, default: 0 },
  }],
  aiSummary: {
    commonCustomerNeeds: { type: String, default: 'Not evaluated' },
    frequentlyDiscussedProducts: [{ type: String }],
    recurringObjections: [{ type: String }],
    salesOutcomesSummary: { type: String, default: 'Not evaluated' },
    salespersonStrengths: [{ type: String }],
    areasForImprovement: [{ type: String }],
    followUpPriorities: [{ type: String }],
    actionableRecommendations: [{ type: String }],
    provider: { type: String, default: 'deterministic' },
    generatedAt: { type: Date, default: Date.now },
  },
  conversations: [{ type: mongoose.Schema.Types.Mixed }],
  storeBreakdown: [{
    storeCode: { type: String, required: true },
    storeName: { type: String, default: '' },
    location: { type: String, default: '' },
    manager: { type: String, default: '' },
    totalConversations: { type: Number, default: 0 },
    analyzedCount: { type: Number, default: 0 },
    pendingCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    wonCount: { type: Number, default: 0 },
    lostCount: { type: Number, default: 0 },
    verifiedSalesCount: { type: Number, default: 0 },
    verifiedRevenue: { type: Number, default: 0 },
    verifiedRevenueDisplay: { type: String, default: '$0' },
    conversionRate: { type: Number, default: 0 },
  }],
  dataLimitations: [{ type: String }],
  activeFilters: { type: mongoose.Schema.Types.Mixed },
  conversationIds: [{ type: String }],
  conversationsHash: {
    type: String,
    default: '',
  },
  lastRefreshedAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('DailyReport', DailyReportSchema);
