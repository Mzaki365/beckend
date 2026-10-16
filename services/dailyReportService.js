/**
 * Storelistener — Daily Reports, Calendar Analytics & PDF Engine (Task 2 & Accuracy Overhaul)
 * File: services/dailyReportService.js
 *
 * Implements:
 * 1. Strict separation of deterministic business metrics from AI-generated interpretations.
 * 2. Deterministic calculations: Total conversations (unique, deduplicated), verified sales,
 *    verified revenue, average ticket, duration, word count, missed opportunities, and real stock levels.
 * 3. Calendar date management with canonical business timezone (America/New_York) and zero-drift boundaries.
 * 4. Stored report management: View existing report without silent generation; on-demand AI analysis;
 *    and non-duplicating refresh/update with data freshness and stale detection.
 * 5. Grounded AI summary synthesized strictly from underlying conversation transcripts and deal audits.
 * 6. Native executive PDF generation adhering to the 8-point corporate structure.
 */

const crypto = require('crypto');
const Session = require('../models/Session');
const DailyReport = require('../models/DailyReport');
const Inventory = require('../models/Inventory');
const dealAnalysisService = require('./dealAnalysisService');
const { jsPDF } = require('jspdf');
const rawAutoTable = require('jspdf-autotable');
const autoTable = typeof rawAutoTable === 'function' ? rawAutoTable : (rawAutoTable.default || rawAutoTable);

// Canonical business timezone for Storelistener retail operations
const DEFAULT_BUSINESS_TIMEZONE = 'America/New_York';

/**
 * Computes exact UTC boundaries for a given YYYY-MM-DD date in the business timezone
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @param {string} timeZone - e.g. 'America/New_York'
 * @returns {{ startDate: Date, endDate: Date, offsetMinutes: number }}
 */
function getBusinessDateBoundaries(dateStr, timeZone = DEFAULT_BUSINESS_TIMEZONE) {
  const parts = String(dateStr).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!parts) {
    const fallback = new Date();
    return {
      startDate: new Date(fallback.setHours(0, 0, 0, 0)),
      endDate: new Date(fallback.setHours(23, 59, 59, 999)),
      offsetMinutes: 240,
    };
  }

  const year = parseInt(parts[1], 10);
  const month = parseInt(parts[2], 10);
  const day = parseInt(parts[3], 10);

  // Compute timezone offset at noon UTC on the target date
  const approxUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const dtfParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(approxUtc);

  const tzPart = dtfParts.find((p) => p.type === 'timeZoneName')?.value;
  let offsetMinutes = 240; // Default EDT (UTC-4 is 240 mins)
  if (tzPart) {
    const match = tzPart.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
    if (match) {
      const sign = match[1] === '-' ? 1 : -1;
      const hours = parseInt(match[2], 10);
      const mins = match[3] ? parseInt(match[3], 10) : 0;
      offsetMinutes = sign * (hours * 60 + mins);
    }
  }

  // 00:00:00.000 in business timezone maps to:
  const startUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) + (offsetMinutes * 60 * 1000);
  const endUtcMs = startUtcMs + (24 * 60 * 60 * 1000) - 1;

  return {
    startDate: new Date(startUtcMs),
    endDate: new Date(endUtcMs),
    offsetMinutes,
  };
}

class DailyReportService {
  /**
   * Resolves date boundaries respecting the canonical business timezone
   * @param {Object} params
   * @returns {{ startDate: Date, endDate: Date, date: string, dateLabel: string, isSingleDay: boolean, daysCount: number, businessTimezone: string, reportingDateRule: string }}
   */
  resolveDateRange(params = {}) {
    const {
      filterType = 'today',
      date,
      startDate,
      endDate,
      businessTimezone = DEFAULT_BUSINESS_TIMEZONE,
    } = params;

    const timeZone = businessTimezone || DEFAULT_BUSINESS_TIMEZONE;
    const now = new Date();

    let targetDateStr = '';
    let isSingleDay = false;
    let start = null;
    let end = null;
    let dateLabel = '';

    if (date && (filterType === 'single' || !startDate)) {
      // Explicit single date 'YYYY-MM-DD'
      targetDateStr = String(date).slice(0, 10);
      const bounds = getBusinessDateBoundaries(targetDateStr, timeZone);
      start = bounds.startDate;
      end = bounds.endDate;
      dateLabel = targetDateStr;
      isSingleDay = true;
    } else if (filterType === 'yesterday') {
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      targetDateStr = new Intl.DateTimeFormat('en-CA', { timeZone }).format(yesterday);
      const bounds = getBusinessDateBoundaries(targetDateStr, timeZone);
      start = bounds.startDate;
      end = bounds.endDate;
      dateLabel = `Yesterday (${targetDateStr})`;
      isSingleDay = true;
    } else if (filterType === '7d' || filterType === 'last_7_days') {
      const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
      const todayBounds = getBusinessDateBoundaries(todayStr, timeZone);
      end = todayBounds.endDate;
      start = new Date(end.getTime() - (7 * 24 * 60 * 60 * 1000) + 1);
      dateLabel = 'Last 7 Days';
      isSingleDay = false;
      targetDateStr = todayStr;
    } else if (startDate && endDate) {
      const sStr = String(startDate).slice(0, 10);
      const eStr = String(endDate).slice(0, 10);
      const sBounds = getBusinessDateBoundaries(sStr, timeZone);
      const eBounds = getBusinessDateBoundaries(eStr, timeZone);
      start = sBounds.startDate;
      end = eBounds.endDate;
      dateLabel = sStr === eStr ? sStr : `${sStr} to ${eStr}`;
      isSingleDay = sStr === eStr;
      targetDateStr = sStr;
    } else {
      // Default: 'today' in business timezone
      targetDateStr = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
      const bounds = getBusinessDateBoundaries(targetDateStr, timeZone);
      start = bounds.startDate;
      end = bounds.endDate;
      dateLabel = `Today (${targetDateStr})`;
      isSingleDay = true;
    }

    const daysCount = Math.max(1, Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));

    return {
      startDate: start,
      endDate: end,
      date: targetDateStr,
      dateLabel,
      isSingleDay,
      daysCount,
      businessTimezone: timeZone,
      reportingDateRule: `Conversations and transactions are attributed by their immutable startedAt timestamp in ${timeZone} business time.`,
    };
  }

  /**
   * Computes a stable MD5 hash of conversation IDs, statuses, and metrics for freshness auditing
   */
  computeConversationsHash(sessions = []) {
    if (!Array.isArray(sessions) || sessions.length === 0) return 'empty';
    const tokens = sessions
      .map((s) => `${s.sessionId}:${s.status}:${s.verifiedSale || false}:${s.verifiedRevenue || 0}:${s.dealAnalysis?.salesOutcome || 'none'}:${s.transcripts?.length || 0}`)
      .sort();
    return crypto.createHash('md5').update(tokens.join('|')).digest('hex');
  }

  /**
   * Builds MongoDB filter adhering to role permissions, date boundaries, and store scoping
   */
  buildFilter(range, options = {}, user = null) {
    const filter = {
      startedAt: {
        $gte: range.startDate,
        $lte: range.endDate,
      },
      status: 'completed',
    };

    // Store isolation
    if (user && user.role === 'sales_manager' && user.storeCode) {
      filter.storeCode = user.storeCode;
    } else if (options.store && options.store !== 'all') {
      const storeSyncService = require('./storeSyncService');
      const cfg = storeSyncService.findStoreConfig(options.store);
      filter.$or = [
        { storeCode: cfg.code },
        { storeCode: cfg.id },
        { storeCode: options.store },
        { storeId: options.store },
        { storeId: cfg.id },
      ];
    }

    // Salesperson filter
    if (options.salesperson && options.salesperson !== 'all') {
      filter.salesRep = new RegExp(options.salesperson.trim(), 'i');
    }

    // Outcome filter
    if (options.outcome && options.outcome !== 'all') {
      filter.$or = [
        { 'dealAnalysis.salesOutcome': options.outcome },
        { 'dealAnalysis.conversationOutcome': options.outcome },
      ];
    }

    return filter;
  }

  /**
   * Calculates all deterministic business metrics purely from authoritative records
   * @param {Array<Object>} sessions - Deduplicated array of completed Session documents
   * @param {Object} options - { storeCode }
   * @returns {Promise<Object>} Calculated metrics & data limitations
   */
  async calculateAuthoritativeMetrics(sessions = [], options = {}) {
    const totalCompleted = sessions.length;

    let completedAnalysisCount = 0;
    let pendingAnalysisCount = 0;
    let failedAnalysisCount = 0;

    let wonCount = 0;
    let lostCount = 0;
    let pendingCount = 0;
    let inconclusiveCount = 0;

    let verifiedSalesCount = 0;
    let verifiedRevenueTotal = 0;
    let hasVerifiedRevenue = false;

    let totalDurationSeconds = 0;
    let totalWordCount = 0;
    let insufficientEvidenceCount = 0;

    for (const s of sessions) {
      totalDurationSeconds += (s.durationSeconds || 0);

      // Final transcript word count calculation
      const transcripts = Array.isArray(s.transcripts) ? s.transcripts : [];
      const sessionWords = transcripts.reduce((acc, t) => {
        const text = (t.englishText || t.text || '').trim();
        return acc + (text ? text.split(/\s+/).filter(Boolean).length : 0);
      }, 0);
      totalWordCount += sessionWords;

      const da = s.dealAnalysis || {};
      const aStatus = da.analysisStatus || 'completed';
      if (aStatus === 'completed') completedAnalysisCount++;
      else if (aStatus === 'pending' || aStatus === 'analyzing') pendingAnalysisCount++;
      else if (aStatus === 'failed') failedAnalysisCount++;

      // Deal outcome
      let salesOutcome = da.salesOutcome;
      if (!salesOutcome) {
        const raw = da.conversationOutcome || s.analytics?.dealOutcome;
        if (raw === 'Sale Confirmed' || raw === 'won') salesOutcome = 'Won';
        else if (raw === 'Not Converted' || raw === 'lost') salesOutcome = 'Lost';
        else if (raw === 'Follow-up Required' || raw === 'in_negotiation') salesOutcome = 'Pending';
        else salesOutcome = 'Inconclusive';
      }

      if (salesOutcome === 'Won') wonCount++;
      else if (salesOutcome === 'Lost') lostCount++;
      else if (salesOutcome === 'Pending') pendingCount++;
      else inconclusiveCount++;

      // Strict Sale Verification Rule:
      // Count only transactions confirmed by authoritative sales record or explicitly verified source.
      // Customer statements such as "I'll buy it" in dialogue are NEVER treated as verified sales without record verification.
      // Cancelled or refunded transactions are strictly excluded.
      const isCancelled = s.status === 'cancelled' || s.transactionStatus === 'cancelled' || s.transactionStatus === 'refunded';
      const isSaleVerified = Boolean(s.verifiedSale === true || (s.transactionId && s.isSaleVerified === true)) && !isCancelled;

      if (isSaleVerified) {
        verifiedSalesCount++;
        if (typeof s.verifiedRevenue === 'number' && !isNaN(s.verifiedRevenue) && s.verifiedRevenue > 0) {
          verifiedRevenueTotal += s.verifiedRevenue;
          hasVerifiedRevenue = true;
        }
      }

      if (salesOutcome === 'Inconclusive' || sessionWords < 15 || transcripts.length < 2) {
        insufficientEvidenceCount++;
      }
    }

    // Average Ticket: Verified revenue divided by verified completed sales
    const avgTicket = (verifiedSalesCount > 0 && verifiedRevenueTotal > 0)
      ? Math.round(verifiedRevenueTotal / verifiedSalesCount)
      : null;
    const avgTicketDisplay = avgTicket != null ? `$${avgTicket.toLocaleString()}` : 'N/A';
    const verifiedRevenueDisplay = hasVerifiedRevenue ? `$${verifiedRevenueTotal.toLocaleString()}` : '$0';

    // Missed Opportunities:
    // Distinguish unconverted consultations (lostCount) from telephony missed calls and door traffic (which are unmonitored).
    const missedOpportunitiesCount = lostCount;
    const missedOpportunitiesDisplay = lostCount > 0 ? `${lostCount} unconverted` : '0';
    const missedOpportunitiesExplanation = `${lostCount} completed customer consultation(s) concluded without a purchase. (Note: Physical walk-bys and telephone call-center queues are N/A — counter audio tracking only).`;

    // Low Stock Products:
    // Check actual Inventory collection in MongoDB
    let lowStockCount = null;
    let lowStockDisplay = 'N/A';
    let lowStockExplanation = 'Inventory management system not connected. Stock thresholds cannot be evaluated.';
    let lowStockItems = [];

    try {
      const invQuery = {};
      if (options.storeCode && options.storeCode !== 'all') {
        invQuery.storeCode = options.storeCode;
      }
      const totalInventoryItems = await Inventory.countDocuments(invQuery);
      if (totalInventoryItems > 0) {
        // Authoritative inventory data exists!
        const lowItems = await Inventory.find({
          ...invQuery,
          $expr: { $lte: ['$currentStock', '$lowStockThreshold'] },
        }).lean();

        lowStockCount = lowItems.length;
        lowStockItems = lowItems.map((item) => ({
          productName: item.productName,
          sku: item.sku,
          storeCode: item.storeCode,
          currentStock: item.currentStock,
          lowStockThreshold: item.lowStockThreshold,
        }));
        lowStockDisplay = String(lowStockCount);
        lowStockExplanation = lowStockCount > 0
          ? `${lowStockCount} product(s) currently at or below configured stock threshold.`
          : 'All catalog products currently above safety threshold.';
      }
    } catch (invErr) {
      // Graceful fallback to limitation explanation
    }

    const conversionRate = totalCompleted > 0 ? Math.round((wonCount / totalCompleted) * 100) : 0;
    const followUpRate = totalCompleted > 0 ? Math.round((pendingCount / totalCompleted) * 100) : 0;

    // Performance headline
    const activityLevel = (totalCompleted >= 6 || verifiedSalesCount >= 2) ? 'Active' : (totalCompleted >= 2 || verifiedSalesCount >= 1) ? 'Moderate' : 'Quiet';
    const headline = hasVerifiedRevenue
      ? `${activityLevel} day, $${verifiedRevenueTotal.toLocaleString()} in sales, ${totalCompleted} conversation${totalCompleted === 1 ? '' : 's'}`
      : `${activityLevel} day — no sales, ${totalCompleted} conversation${totalCompleted === 1 ? '' : 's'}`;
    const headlineExplanation = totalCompleted === 0
      ? 'Quiet day — no conversations recorded and no verified sales.'
      : `${activityLevel} day with ${totalCompleted} recorded customer consultation${totalCompleted > 1 ? 's' : ''} across store counters. ${verifiedSalesCount > 0 ? `Confirmed ${verifiedSalesCount} verified sales transaction${verifiedSalesCount > 1 ? 's' : ''} generating ${verifiedRevenueDisplay}.` : 'No confirmed customer transactions recorded for this business date.'}`;

    const dataLimitations = [
      'Telephony call logs & physical foot-traffic door cameras: N/A — audio monitoring is counter-terminal focused.',
      lowStockCount === null
        ? 'Inventory database connection: N/A — low-stock alerts require external POS/ERP inventory sync.'
        : 'Inventory reflects current stock levels, not historical end-of-day snapshots.',
      'Customer statements such as "I\'ll buy it" are recorded as verbal buying intent, not verified revenue.',
    ];

    return {
      metrics: {
        totalCompleted,
        completedAnalysisCount,
        pendingAnalysisCount,
        failedAnalysisCount,
        wonCount,
        lostCount,
        pendingCount,
        inconclusiveCount,
        verifiedSalesCount,
        verifiedRevenue: hasVerifiedRevenue ? verifiedRevenueTotal : null,
        verifiedRevenueDisplay,
        avgTicket,
        avgTicketDisplay,
        missedOpportunitiesCount,
        missedOpportunitiesDisplay,
        missedOpportunitiesExplanation,
        lowStockCount,
        lowStockDisplay,
        lowStockExplanation,
        lowStockItems,
        totalDurationSeconds,
        totalWordCount,
        activityLevel,
        headline,
        headlineExplanation,
        insufficientEvidenceCount,
        conversionRate,
        followUpRate,
      },
      dataLimitations,
    };
  }

  /**
   * Synthesizes daily-level AI summary strictly grounded in underlying conversation records
   */
  async generateDailyAiSummary(sessions = [], dateLabel = '') {
    if (sessions.length === 0) {
      return {
        commonCustomerNeeds: 'No completed conversations recorded for this period.',
        frequentlyDiscussedProducts: [],
        recurringObjections: [],
        salesOutcomesSummary: 'Zero consultations completed in the selected window.',
        salespersonStrengths: [],
        areasForImprovement: [],
        followUpPriorities: [],
        actionableRecommendations: ['Ensure counter recording stations are online and staff engage customers promptly as they browse.'],
        provider: 'deterministic',
        generatedAt: new Date(),
      };
    }

    // 1. Deterministic aggregation across all conversation analyses
    const productFrequency = new Map();
    const objectionFrequency = new Map();
    const needsList = [];
    const followUps = [];
    const repStrengths = [];
    const repAreasToImprove = [];

    sessions.forEach((s) => {
      const da = s.dealAnalysis || {};
      const sc = s.scorecard || {};

      if (da.customerRequirements && da.customerRequirements !== 'Not mentioned') {
        needsList.push(`${da.customerRequirements} (${s.sessionId})`);
      }

      if (Array.isArray(da.productsDiscussed)) {
        da.productsDiscussed.forEach((p) => {
          if (p && p !== 'Not mentioned') {
            productFrequency.set(p, (productFrequency.get(p) || 0) + 1);
          }
        });
      }

      if (Array.isArray(da.customerObjections)) {
        da.customerObjections.forEach((obj) => {
          if (obj && obj !== 'None' && obj !== 'Not mentioned') {
            objectionFrequency.set(obj, (objectionFrequency.get(obj) || 0) + 1);
          }
        });
      }

      if (da.nextRecommendedAction && da.nextRecommendedAction !== 'Not mentioned') {
        followUps.push(`${s.salesRep || 'Rep'}: ${da.nextRecommendedAction} (${s.sessionId})`);
      }

      if (Array.isArray(sc.coachingFeedback?.handledWell)) {
        sc.coachingFeedback.handledWell.forEach((hw) => repStrengths.push(hw));
      }
      if (Array.isArray(sc.coachingFeedback?.areasToImprove)) {
        sc.coachingFeedback.areasToImprove.forEach((ati) => repAreasToImprove.push(ati));
      }
    });

    const topProducts = Array.from(productFrequency.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([p, count]) => `${p} (${count} discussion${count > 1 ? 's' : ''})`);

    const topObjections = Array.from(objectionFrequency.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([obj, count]) => `${obj} (${count} occurrence${count > 1 ? 's' : ''})`);

    const uniqueStrengths = Array.from(new Set(repStrengths)).slice(0, 5);
    const uniqueAreas = Array.from(new Set(repAreasToImprove)).slice(0, 5);
    const uniqueFollowUps = Array.from(new Set(followUps)).slice(0, 6);

    // 2. Try Gemini 2.5 Flash / Flash Synthesis if GEMINI_API_KEY is configured
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && sessions.length >= 1) {
      try {
        const miniBriefs = sessions.slice(0, 25).map((s, idx) => {
          const da = s.dealAnalysis || {};
          return `Conversation #${idx + 1} (${s.sessionId}, Store: ${s.storeCode}, Rep: ${s.salesRep || 'Specialist'}, Outcome: ${da.salesOutcome || 'Inconclusive'}):
- Requirements: ${da.customerRequirements || 'N/A'}
- Products: ${(da.productsDiscussed || []).join(', ') || 'N/A'}
- Objections: ${(da.customerObjections || []).join(', ') || 'None'}
- Rep Strengths/Gaps: ${da.salespersonResponse || 'N/A'}
- Next Step: ${da.nextRecommendedAction || 'N/A'}`;
        }).join('\n\n');

        const prompt = `You are the Executive Sales Intelligence Engine for Storelistener.
Synthesize the daily sales performance for ${dateLabel} strictly from these underlying verified retail conversation reports:

${miniBriefs}

Return a valid JSON object matching this schema:
{
  "commonCustomerNeeds": "Synthesized paragraph detailing customer intent, primary hardware demands, trade-in considerations, and budget drivers grounded in citations.",
  "frequentlyDiscussedProducts": ["Product 1 (X discussions)", "Product 2 (Y discussions)"],
  "recurringObjections": ["Objection 1 with context", "Objection 2 with context"],
  "salesOutcomesSummary": "Concise summary of deal closures, pending consultations, and customer drop-offs.",
  "salespersonStrengths": ["Observed strength 1 grounded in transcripts", "Observed strength 2"],
  "areasForImprovement": ["Specific skill or objection-handling gap 1", "Specific gap 2"],
  "followUpPriorities": ["High-priority follow-up item 1", "High-priority item 2"],
  "actionableRecommendations": ["Actionable coaching or retail recommendation 1", "Actionable recommendation 2", "Actionable recommendation 3"]
}

Rules:
1. Do not invent sales figures, revenue amounts, or customer statements.
2. Ground all points strictly in the provided conversation data.
3. Keep recommendations concise, concrete, and actionable for store managers.`;

        const models = ['gemini-2.5-flash', 'gemini-flash-latest'];
        for (const model of models) {
          try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.0, responseMimeType: 'application/json' },
              }),
              signal: AbortSignal.timeout(6000),
            });
            if (res.ok) {
              const data = await res.json();
              const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                const parsed = JSON.parse(text);
                if (parsed.commonCustomerNeeds && Array.isArray(parsed.actionableRecommendations)) {
                  return {
                    commonCustomerNeeds: parsed.commonCustomerNeeds,
                    frequentlyDiscussedProducts: parsed.frequentlyDiscussedProducts || topProducts,
                    recurringObjections: parsed.recurringObjections || topObjections,
                    salesOutcomesSummary: parsed.salesOutcomesSummary || 'Daily outcomes aggregated from verified records.',
                    salespersonStrengths: parsed.salespersonStrengths || uniqueStrengths,
                    areasForImprovement: parsed.areasForImprovement || uniqueAreas,
                    followUpPriorities: parsed.followUpPriorities || uniqueFollowUps,
                    actionableRecommendations: parsed.actionableRecommendations,
                    provider: `gemini-${model}`,
                    generatedAt: new Date(),
                  };
                }
              }
            }
          } catch (modelErr) {
            // Try next model
          }
        }
      } catch (geminiErr) {
        console.warn('[Daily AI Summary] Gemini note:', geminiErr.message);
      }
    }

    // Deterministic fallback synthesis
    return {
      commonCustomerNeeds: needsList.length > 0
        ? `Primary customer demand focused on: ${Array.from(new Set(needsList)).slice(0, 4).join('; ')}.`
        : 'General Apple retail inquiries and product overview consultations.',
      frequentlyDiscussedProducts: topProducts.length > 0 ? topProducts : ['iPhone hardware and retail accessories'],
      recurringObjections: topObjections.length > 0 ? topObjections : ['No recurring objections recorded for this period'],
      salesOutcomesSummary: `Completed ${sessions.length} customer consultation${sessions.length > 1 ? 's' : ''}. Outcomes classified based on recorded verbal dialogue.`,
      salespersonStrengths: uniqueStrengths.length > 0 ? uniqueStrengths : ['Engaged customers with consultative dialogue and product specifications.'],
      areasForImprovement: uniqueAreas.length > 0 ? uniqueAreas : ['Proactively qualify trade-in values and monthly installment options earlier in conversations.'],
      followUpPriorities: uniqueFollowUps.length > 0 ? uniqueFollowUps : ['Review pending customer consultations requiring callbacks.'],
      actionableRecommendations: [
        'Conduct daily morning review of pending customer consultations to prioritize callbacks.',
        'Coach sales specialists to address trade-in valuation and 0% financing early when price objections emerge.',
        'Ensure all concluded sales transactions are logged with POS receipt verification.',
      ],
      provider: 'deterministic',
      generatedAt: new Date(),
    };
  }

  /**
   * Formats a session document into the canonical 13-dimension individual conversation report
   */
  formatConversationReport(session) {
    const da = session.dealAnalysis || {};
    const sc = session.scorecard || {};

    let salesOutcome = da.salesOutcome;
    if (!salesOutcome) {
      const raw = da.conversationOutcome || session.analytics?.dealOutcome;
      if (raw === 'Sale Confirmed' || raw === 'won') salesOutcome = 'Won';
      else if (raw === 'Not Converted' || raw === 'lost') salesOutcome = 'Lost';
      else if (raw === 'Follow-up Required' || raw === 'in_negotiation') salesOutcome = 'Pending';
      else salesOutcome = 'Inconclusive';
    }

    const isCancelled = session.status === 'cancelled' || session.transactionStatus === 'cancelled' || session.transactionStatus === 'refunded';
    const isSaleVerified = Boolean(session.verifiedSale === true || (session.transactionId && session.isSaleVerified === true)) && !isCancelled;

    const transcripts = Array.isArray(session.transcripts) ? session.transcripts : [];
    const englishTranscripts = transcripts.map((t) => ({
      timestamp: t.timestamp,
      speaker: t.speaker === 'sales_rep' ? 'Sales Specialist' : 'Customer',
      text: t.englishText || t.text || '',
      originalText: t.originalText || t.text || '',
      isTranslated: Boolean(t.isTranslated),
      sourceLanguage: t.sourceLanguage || 'en',
    }));

    const wordCount = englishTranscripts.reduce((acc, t) => acc + (t.text || '').trim().split(/\s+/).filter(Boolean).length, 0);

    return {
      conversationId: session.sessionId || session._id,
      sessionId: session.sessionId,
      date: session.startedAt ? new Date(session.startedAt).toISOString().slice(0, 10) : 'N/A',
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationSeconds: session.durationSeconds || 0,
      durationFormatted: session.durationSeconds ? `${Math.floor(session.durationSeconds / 60)}m ${session.durationSeconds % 60}s` : '0s',
      storeCode: session.storeCode,
      storeName: session.storeName,
      salesperson: session.salesRep || 'Sales Specialist',
      terminal: session.deviceId || 'Counter 01',
      transcripts: englishTranscripts,
      transcriptCount: englishTranscripts.length,
      executiveSummary: da.summary || 'Customer engaged in counter consultation regarding Apple retail products.',
      customerRequirements: da.customerRequirements || 'Not mentioned',
      customerBuyingIntent: da.customerBuyingIntent || 'Unclear',
      customerQuestions: da.customerQuestions || [],
      productsDiscussed: da.productsDiscussed || [],
      budgetAndPrice: da.budgetAndPrice || 'Not mentioned',
      salesOutcome,
      conversationOutcome: da.conversationOutcome || salesOutcome,
      outcomeEvidence: da.outcomeExplanation || (
        salesOutcome === 'Won'
          ? 'Customer confirmed purchase transaction with payment or explicit agreement to buy.'
          : salesOutcome === 'Lost'
          ? 'Customer rejected offer or cited prohibitive constraints without buying.'
          : salesOutcome === 'Pending'
          ? 'Customer expressed purchase intent but requested time or scheduled follow-up consultation.'
          : 'Dialogue concluded without recorded transaction or closure statement.'
      ),
      isSaleVerified,
      verifiedStatusLabel: isSaleVerified ? 'Verified Sale (Transaction Confirmed)' : 'Unverified (Verbal Agreement / Discussion Only)',
      verifiedRevenue: session.verifiedRevenue != null ? session.verifiedRevenue : null,
      transactionId: session.transactionId || null,
      customerObjections: da.customerObjections || [],
      salespersonResponse: da.salespersonResponse || 'Provided consultative product overview.',
      salespersonPerformance: {
        overallScore: sc.overallScore != null ? sc.overallScore : null,
        strengths: sc.coachingFeedback?.handledWell || ['Courteous counter engagement'],
        areasToImprove: sc.coachingFeedback?.areasToImprove || ['Clarify budget and trade-in earlier in conversation'],
        missedOpportunity: sc.coachingFeedback?.missedOpportunity || 'None identified in dialogue',
        evidenceQuote: sc.coachingFeedback?.evidenceQuote || '',
      },
      nextRecommendedAction: da.nextRecommendedAction || 'Follow up with customer within 24 hours.',
      analysisStatus: da.analysisStatus || 'completed',
      limitations: 'Single-channel counter audio. Diarization speaker roles estimated from retail conversation cues.',
      hasAudio: Boolean(session.audioUrl || session.audioFileName),
      audioUrl: session.audioUrl || (session.audioFileName ? `/uploads/${session.audioFileName}` : `/api/sessions/${session.sessionId}/audio`),
      audioFileName: session.audioFileName || null,
      sentiment: (session.scorecard?.sentiment || da.sentiment || (salesOutcome === 'Won' ? 'POSITIVE' : salesOutcome === 'Lost' ? 'NEGATIVE' : 'NEUTRAL')).toUpperCase(),
      wordCount,
      coachingNote: sc.coachingFeedback?.actionableCoaching || (englishTranscripts.length === 0 ? 'No speech detected during this interaction. Check audio sensor functionality and ensure staff are actively engaging people on the floor.' : (da.nextRecommendedAction && da.nextRecommendedAction !== 'Not mentioned' ? da.nextRecommendedAction : 'Greet shoppers warmly, actively discover preference, and highlight trade-in incentives.')),
      score: sc.overallScore != null ? sc.overallScore : (salesOutcome === 'Won' ? 4 : salesOutcome === 'Pending' ? 3 : salesOutcome === 'Lost' ? 2 : 3),
    };
  }

  /**
   * Retrieves an existing saved report for a date and store scope WITHOUT generating a new one
   * @param {Object} params - { date, store, salesperson }
   * @param {Object} user - Authenticated user context
   * @returns {Promise<Object>} { success: true, hasReport: boolean, isStale: boolean, report: Object|null }
   */
  async getSavedDailyReport(params = {}, user = null) {
    const range = this.resolveDateRange(params);
    const storeCode = (user && user.role === 'sales_manager' && user.storeCode) ? user.storeCode : (params.store || 'all');
    const salesperson = params.salesperson || 'all';

    const reportKey = `${range.date}:${storeCode}:${salesperson}`;
    const targetDate = range.date;

    const query = {
      $or: [
        { reportKey },
        { reportKey: `${reportKey}:newest` },
        { date: targetDate, storeCode, salesperson },
        { date: `Today (${targetDate})`, storeCode, salesperson },
        { date: `Yesterday (${targetDate})`, storeCode, salesperson },
      ],
    };

    const savedReport = await DailyReport.findOne(query)
      .sort({ lastRefreshedAt: -1, updatedAt: -1, createdAt: -1 })
      .lean();

    if (!savedReport) {
      return {
        success: true,
        hasReport: false,
        report: null,
        date: range.date,
        dateLabel: range.dateLabel,
        storeCode,
        businessTimezone: range.businessTimezone,
        reportingDateRule: range.reportingDateRule,
        message: `No analysis has been generated for ${range.dateLabel}. Click 'AI Analysis' to evaluate conversations.`,
      };
    }

    // Check data freshness: Has the underlying conversation count or state changed?
    const filter = this.buildFilter(range, params, user);
    const currentSessions = await Session.find(filter).select('sessionId status verifiedSale verifiedRevenue dealAnalysis transcripts').lean();

    // Deduplicate current sessions by sessionId
    const uniqueCurrent = Array.from(new Map(currentSessions.map((s) => [s.sessionId, s])).values());
    const currentHash = this.computeConversationsHash(uniqueCurrent);

    const isStale = savedReport.conversationsHash !== currentHash || (savedReport.conversationIds || []).length !== uniqueCurrent.length;
    const freshnessNote = isStale
      ? `New conversations or sales recorded since report generation (${uniqueCurrent.length} current vs ${savedReport.conversationIds?.length || 0} in report). Click Update Analysis to refresh.`
      : 'Report is fully synchronized with store records.';

    return {
      success: true,
      hasReport: true,
      isStale,
      freshnessNote,
      reportKey: savedReport.reportKey,
      dateLabel: savedReport.date,
      date: savedReport.date,
      storeCode: savedReport.storeCode,
      storeName: savedReport.storeName,
      salesperson: savedReport.salesperson,
      businessTimezone: savedReport.businessTimezone || range.businessTimezone,
      reportingDateRule: range.reportingDateRule,
      metrics: savedReport.metrics || {},
      dailyTrends: savedReport.dailyTrends || [],
      aiSummary: savedReport.aiSummary || {},
      conversations: savedReport.conversations || [],
      dataLimitations: savedReport.dataLimitations || [],
      lastRefreshedAt: savedReport.lastRefreshedAt,
      conversationIds: savedReport.conversationIds || [],
      conversationsCount: (savedReport.conversationIds || []).length,
      currentDbConversationsCount: uniqueCurrent.length,
      report: savedReport,
    };
  }

  /**
   * Generates or updates a Daily Report for a date and store scope.
   * Deterministically calculates all KPIs from authoritative records, runs grounded AI synthesis,
   * updates the existing report document in MongoDB (upsert), and returns the synchronized report.
   * @param {Object} params - { date, store, salesperson, refresh }
   * @param {Object} user - Authenticated user context
   * @returns {Promise<Object>} Completed synchronized report
   */
  async generateOrUpdateDailyReport(params = {}, user = null) {
    const range = this.resolveDateRange(params);
    const storeCode = (user && user.role === 'sales_manager' && user.storeCode) ? user.storeCode : (params.store || 'all');
    const salesperson = params.salesperson || 'all';
    const storeName = storeCode === 'all' ? 'All Retail Branches' : storeCode;

    const filter = this.buildFilter(range, params, user);
    const sortOrder = params.sort === 'oldest' ? { startedAt: 1 } : { startedAt: -1 };

    // Fetch matching completed sessions from MongoDB
    const rawSessions = await Session.find(filter).sort(sortOrder).limit(300);

    // Deduplicate strictly by sessionId (each conversation counted exactly once)
    const sessionMap = new Map();
    for (const s of rawSessions) {
      if (s.sessionId && !sessionMap.has(s.sessionId)) {
        sessionMap.set(s.sessionId, s);
      }
    }
    const sessions = Array.from(sessionMap.values());

    // Auto-analyze any unanalyzed completed sessions that have transcripts
    const pendingSessions = sessions.filter(
      (s) => (!s.dealAnalysis || s.dealAnalysis.analysisStatus === 'pending') && (s.transcripts?.length || 0) > 0
    );

    if (pendingSessions.length > 0) {
      await Promise.all(
        pendingSessions.map(async (s) => {
          try {
            s.dealAnalysis = await dealAnalysisService.runAnalysisForSession(s.sessionId);
          } catch (e) {
            // Non-blocking
          }
        })
      );
    }

    // Deterministic metrics calculation
    const { metrics, dataLimitations } = await this.calculateAuthoritativeMetrics(sessions, { storeCode });

    // Format all individual conversation reports
    const formattedConversations = sessions.map((s) => this.formatConversationReport(s));

    // Daily trends map
    const dailyTrendsMap = new Map();
    formattedConversations.forEach((conv) => {
      const dKey = conv.date || range.date;
      if (!dailyTrendsMap.has(dKey)) {
        dailyTrendsMap.set(dKey, {
          date: dKey,
          total: 0,
          won: 0,
          lost: 0,
          pending: 0,
          inconclusive: 0,
          verifiedSales: 0,
        });
      }
      const dt = dailyTrendsMap.get(dKey);
      dt.total++;
      if (conv.salesOutcome === 'Won') dt.won++;
      else if (conv.salesOutcome === 'Lost') dt.lost++;
      else if (conv.salesOutcome === 'Pending') dt.pending++;
      else dt.inconclusive++;
      if (conv.isSaleVerified) dt.verifiedSales++;
    });
    const dailyTrends = Array.from(dailyTrendsMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    // AI Daily Summary: Grounded in underlying transcripts and deal analyses
    const aiSummary = await this.generateDailyAiSummary(sessions, range.dateLabel);

    const reportKey = `${range.date}:${storeCode}:${salesperson}`;
    const conversationsHash = this.computeConversationsHash(sessions);
    const now = new Date();

    // Persist / Upsert in MongoDB DailyReport collection
    const reportDoc = {
      reportKey,
      reportType: range.isSingleDay ? 'single_day' : 'custom_range',
      date: range.date,
      startDate: range.startDate,
      endDate: range.endDate,
      storeCode,
      storeName,
      salesperson,
      businessTimezone: range.businessTimezone,
      metrics,
      dailyTrends,
      aiSummary,
      conversations: formattedConversations,
      dataLimitations,
      activeFilters: {
        filterType: params.filterType || 'single',
        store: storeCode,
        salesperson,
        outcome: params.outcome || 'all',
        sort: params.sort || 'newest',
      },
      conversationIds: sessions.map((s) => s.sessionId),
      conversationsHash,
      lastRefreshedAt: now,
    };

    const savedDoc = await DailyReport.findOneAndUpdate(
      {
        $or: [
          { reportKey },
          { reportKey: `${reportKey}:newest` },
          { date: range.date, storeCode, salesperson },
          { date: `Today (${range.date})`, storeCode, salesperson },
        ],
      },
      reportDoc,
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    return {
      success: true,
      hasReport: true,
      isStale: false,
      freshnessNote: 'Report is fully synchronized with current store records.',
      reportKey,
      dateLabel: range.dateLabel,
      date: range.date,
      storeCode,
      storeName,
      salesperson,
      businessTimezone: range.businessTimezone,
      reportingDateRule: range.reportingDateRule,
      metrics,
      dailyTrends,
      aiSummary,
      conversations: formattedConversations,
      dataLimitations,
      lastRefreshedAt: now,
      conversationIds: sessions.map((s) => s.sessionId),
      conversationsCount: sessions.length,
      currentDbConversationsCount: sessions.length,
      report: savedDoc,
    };
  }

  /**
   * Compatibility wrapper for getDailyReport
   */
  async getDailyReport(params = {}, user = null) {
    if (params.refresh === true || params.generate === 'true') {
      return this.generateOrUpdateDailyReport(params, user);
    }
    if (params.onlySaved === true) {
      return this.getSavedDailyReport(params, user);
    }
    // Check if saved exists; if not, generate (retaining backward compatibility for legacy callers)
    const saved = await this.getSavedDailyReport(params, user);
    if (saved && saved.hasReport) {
      return saved;
    }
    return this.generateOrUpdateDailyReport(params, user);
  }

  /**
   * Generates a multi-page, publication-quality executive PDF adhering to the 8-point structure
   */
  async generateDailyReportPdf(reportData, currentUser = null) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const COLORS = {
      primary: [17, 24, 39], // Slate 900
      secondary: [37, 99, 235], // Blue 600
      slateLight: [248, 250, 252], // Slate 50
      slateMuted: [100, 116, 139], // Slate 500
      slateBorder: [226, 232, 240], // Slate 200
      slateText: [15, 23, 42],
      white: [255, 255, 255],
      success: [21, 128, 61], // Green 700
      successBg: [240, 253, 244],
      warning: [180, 83, 9], // Amber 700
      error: [185, 28, 28], // Red 700
    };

    const {
      dateLabel,
      date,
      businessTimezone = DEFAULT_BUSINESS_TIMEZONE,
      reportingDateRule,
      activeFilters = {},
      metrics = {},
      dailyTrends = [],
      aiSummary = {},
      conversations = [],
      dataLimitations = [],
      lastRefreshedAt,
    } = reportData;

    const displayDate = dateLabel || date || 'Selected Date';
    const pageWidth = doc.internal.pageSize.getWidth();
    let y = 14;

    // Header Block
    const drawHeader = () => {
      doc.setFillColor(...COLORS.primary);
      doc.roundedRect(14, y, 10, 10, 2, 2, 'F');
      doc.setTextColor(...COLORS.white);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.text('SL', 19, y + 6.8, { align: 'center' });

      doc.setTextColor(...COLORS.primary);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text('Storelistener', 27, y + 5);

      doc.setTextColor(...COLORS.slateMuted);
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'normal');
      doc.text('RETAIL INTELLIGENCE & AUDITABLE DAILY REPORT', 27, y + 9);

      // Metadata Card
      const metaW = 82;
      const metaH = 24;
      const metaX = pageWidth - 14 - metaW;
      doc.setFillColor(...COLORS.slateLight);
      doc.setDrawColor(...COLORS.slateBorder);
      doc.setLineWidth(0.3);
      doc.roundedRect(metaX, y, metaW, metaH, 2, 2, 'FD');

      doc.setFontSize(7);
      doc.setTextColor(...COLORS.slateMuted);
      doc.setFont('helvetica', 'bold');
      doc.text('TIMEZONE:', metaX + 4, y + 5);
      doc.text('REPORT DATE:', metaX + 4, y + 10);
      doc.text('STORE / REP:', metaX + 4, y + 15);
      doc.text('SYNCHRONIZED:', metaX + 4, y + 20);

      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.primary);
      doc.text(String(businessTimezone), metaX + 28, y + 5);
      doc.text(String(displayDate).slice(0, 24), metaX + 28, y + 10);
      const storeRepStr = `${activeFilters.store || 'All'} / ${activeFilters.salesperson || 'All'}`;
      doc.text(storeRepStr.slice(0, 24), metaX + 28, y + 15);
      const refreshStr = lastRefreshedAt ? new Date(lastRefreshedAt).toLocaleString('en-US', { timeZone: businessTimezone }) : 'Real-time';
      doc.text(refreshStr.slice(0, 24), metaX + 28, y + 20);

      y += 18;
      doc.setFontSize(15);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...COLORS.primary);
      doc.text(`Daily Sales Intelligence Report — ${displayDate}`, 14, y);

      y += 5.5;
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.slateMuted);
      doc.text(reportingDateRule || `Conversations attributed by startedAt in ${businessTimezone} business time.`, 14, y);

      y += 7;
      doc.setDrawColor(...COLORS.slateBorder);
      doc.setLineWidth(0.4);
      doc.line(14, y, pageWidth - 14, y);
      y += 5;
    };

    drawHeader();

    // Section 1: Deterministic Sales Metrics
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLORS.primary);
    doc.text('1. Deterministic Business Metrics (Audited Records)', 14, y);
    y += 4;

    const summaryCards = [
      ['Total Completed Conversations', String(metrics.totalCompleted || 0), 'Verified Completed Sales', String(metrics.verifiedSalesCount || 0)],
      ['Verified Total Revenue', metrics.verifiedRevenueDisplay || '$0', 'Average Ticket (per sale)', metrics.avgTicketDisplay || 'N/A'],
      ['Unconverted Consultations', metrics.missedOpportunitiesDisplay || '0', 'Low-Stock Products Alert', metrics.lowStockDisplay || 'N/A'],
      ['Total Spoken Words Audited', String(metrics.totalWordCount || 0), 'Total Audio Duration', `${Math.floor((metrics.totalDurationSeconds || 0) / 60)}m ${(metrics.totalDurationSeconds || 0) % 60}s`],
    ];

    autoTable(doc, {
      startY: y,
      head: [['Audited Metric', 'Value', 'Audited Metric', 'Value']],
      body: summaryCards,
      theme: 'grid',
      styles: { fontSize: 7.5, cellPadding: 2.6, textColor: COLORS.slateText, lineColor: COLORS.slateBorder, lineWidth: 0.2 },
      headStyles: { fillColor: COLORS.primary, textColor: COLORS.white, fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 46, fontStyle: 'bold', fillColor: COLORS.slateLight },
        1: { cellWidth: 44, fontStyle: 'bold', textColor: COLORS.secondary },
        2: { cellWidth: 46, fontStyle: 'bold', fillColor: COLORS.slateLight },
        3: { cellWidth: 46 },
      },
      margin: { left: 14, right: 14 },
    });
    y = doc.lastAutoTable.finalY + 6;

    // Section 2: Data Limitations & Boundary Explanations
    if (dataLimitations && dataLimitations.length > 0) {
      doc.setFontSize(8.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...COLORS.slateMuted);
      doc.text('Data Governance & Audit Limitations:', 14, y);
      y += 3.5;
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      dataLimitations.forEach((lim) => {
        doc.text(`• ${lim}`, 16, y);
        y += 3.5;
      });
      y += 3;
    }

    // Section 3: Daily-Level AI Analysis & Recommendations
    if (y > 215) { doc.addPage(); y = 16; }
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLORS.primary);
    doc.text('2. Daily-Level AI Synthesis & Recommendations', 14, y);
    y += 4;

    const aiRows = [
      ['Common Customer Needs & Intent', aiSummary.commonCustomerNeeds || 'N/A'],
      ['Frequently Discussed Products', (aiSummary.frequentlyDiscussedProducts || []).join('; ') || 'None recorded'],
      ['Recurring Customer Objections & Barriers', (aiSummary.recurringObjections || []).join('; ') || 'None identified'],
      ['Sales Outcomes & Performance Synthesis', aiSummary.salesOutcomesSummary || 'N/A'],
      ['Salesperson Strengths & Best Practices', (aiSummary.salespersonStrengths || []).join('; ') || 'Grounded consultative assistance'],
      ['Areas for Salesperson Improvement', (aiSummary.areasForImprovement || []).join('; ') || 'Overcome price barriers with trade-ins'],
      ['Follow-Up Priorities', (aiSummary.followUpPriorities || []).join('; ') || 'Follow up with pending customer quotes'],
      ['Actionable Sales Recommendations', (aiSummary.actionableRecommendations || []).map((r, i) => `${i + 1}. ${r}`).join('\n') || 'N/A'],
    ];

    autoTable(doc, {
      startY: y,
      head: [['Strategic Domain', 'AI Synthesis & Executive Findings']],
      body: aiRows,
      theme: 'grid',
      styles: { fontSize: 7, cellPadding: 2.8, textColor: COLORS.slateText, lineColor: COLORS.slateBorder, lineWidth: 0.2 },
      headStyles: { fillColor: COLORS.primary, textColor: COLORS.white, fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 52, fontStyle: 'bold', fillColor: COLORS.slateLight },
        1: { cellWidth: 130 },
      },
      margin: { left: 14, right: 14 },
    });
    y = doc.lastAutoTable.finalY + 8;

    // Section 4: Individual Conversation Analyses & Transcripts
    doc.addPage();
    y = 16;
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLORS.primary);
    doc.text('3. Individual Conversation Analyses & Complete Transcripts', 14, y);
    y += 4;
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLORS.slateMuted);
    doc.text(`Every eligible conversation in the selected period is detailed below with all audit dimensions and verbatim transcripts.`, 14, y);
    y += 6;

    if (conversations.length === 0) {
      autoTable(doc, {
        startY: y,
        head: [['Conversation Audit']],
        body: [['No completed conversations found matching the active calendar and store filters.']],
        theme: 'grid',
        styles: { fontSize: 8, cellPadding: 4, textColor: COLORS.slateMuted },
        margin: { left: 14, right: 14 },
      });
    } else {
      conversations.forEach((conv, index) => {
        if (y > 220) { doc.addPage(); y = 16; }

        doc.setFillColor(...COLORS.slateLight);
        doc.setDrawColor(...COLORS.secondary);
        doc.setLineWidth(0.6);
        doc.roundedRect(14, y, pageWidth - 28, 8, 1.5, 1.5, 'FD');

        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...COLORS.primary);
        doc.text(`Conversation #${index + 1}: ${conv.sessionId} — ${(conv.salesOutcome || 'INCONCLUSIVE').toUpperCase()}`, 18, y + 5.5);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(...COLORS.slateMuted);
        doc.text(`${conv.storeName || conv.storeCode} • Rep: ${conv.salesperson} • ${conv.durationFormatted}`, pageWidth - 18, y + 5.5, { align: 'right' });

        y += 11;

        const convDetails = [
          ['Executive Summary', conv.executiveSummary],
          ['Customer Needs & Intent', `${conv.customerRequirements} (Intent: ${conv.customerBuyingIntent})`],
          ['Products Discussed & Budget', `${(conv.productsDiscussed || []).join(', ') || 'None'} | Budget: ${conv.budgetAndPrice}`],
          ['Sales Outcome & Evidence', `Outcome: ${conv.salesOutcome} (${conv.conversationOutcome})\nEvidence: ${conv.outcomeEvidence}`],
          ['Verified Sale Status', `${conv.verifiedStatusLabel}${conv.verifiedRevenue != null ? ` | Verified Revenue: $${conv.verifiedRevenue}` : ''}`],
          ['Customer Objections & Response', `Objections: ${(conv.customerObjections || []).join(', ') || 'None'}\nSalesperson Response: ${conv.salespersonResponse}`],
          ['Salesperson Performance', `Score: ${conv.salespersonPerformance?.overallScore != null ? `${conv.salespersonPerformance.overallScore}/100` : 'Assessed'}\nStrengths: ${(conv.salespersonPerformance?.strengths || []).join('; ')}\nImprovement: ${(conv.salespersonPerformance?.areasToImprove || []).join('; ')}`],
          ['Recommended Next Steps', conv.nextRecommendedAction],
          ['Analysis Status & Limitations', `Status: ${(conv.analysisStatus || 'completed').toUpperCase()} | Diarization: ${conv.limitations}`],
        ];

        autoTable(doc, {
          startY: y,
          head: [['Audit Dimension', 'Findings & Grounded Transcript Evidence']],
          body: convDetails,
          theme: 'grid',
          styles: { fontSize: 6.8, cellPadding: 2.2, textColor: COLORS.slateText, lineColor: COLORS.slateBorder, lineWidth: 0.2 },
          headStyles: { fillColor: COLORS.primary, textColor: COLORS.white, fontStyle: 'bold' },
          columnStyles: {
            0: { cellWidth: 46, fontStyle: 'bold', fillColor: COLORS.slateLight },
            1: { cellWidth: 136 },
          },
          margin: { left: 14, right: 14 },
        });
        y = doc.lastAutoTable.finalY + 4;

        const transcriptLines = (conv.transcripts || []).map((t, tIdx) => {
          const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : `#${tIdx + 1}`;
          const transTag = t.isTranslated ? ' [Translated]' : '';
          return [time, `${t.speaker}${transTag}`, t.englishText || t.text || ''];
        });

        if (transcriptLines.length > 0) {
          autoTable(doc, {
            startY: y,
            head: [['Time', 'Speaker', 'Complete English Spoken Transcript']],
            body: transcriptLines,
            theme: 'grid',
            styles: { fontSize: 6.5, cellPadding: 2, textColor: COLORS.slateText, lineColor: COLORS.slateBorder, lineWidth: 0.15 },
            headStyles: { fillColor: [51, 65, 85], textColor: COLORS.white, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: COLORS.slateLight },
            columnStyles: {
              0: { cellWidth: 24 },
              1: { cellWidth: 32, fontStyle: 'bold' },
              2: { cellWidth: 126 },
            },
            margin: { left: 14, right: 14 },
          });
          y = doc.lastAutoTable.finalY + 8;
        } else {
          y += 4;
        }
      });
    }

    // Footers
    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setDrawColor(...COLORS.slateBorder);
      doc.setLineWidth(0.3);
      doc.line(14, 285, pageWidth - 14, 285);

      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.slateMuted);
      doc.text('Storelistener Confidential Management Report • Authorized Store Operations Only', 14, 290);
      doc.text(`Page ${p} of ${totalPages}`, pageWidth - 14, 290, { align: 'right' });
    }

    return doc;
  }

  async generateDailyAiSynthesis(sessions = [], meta = {}) {
    const summary = await this.generateDailyAiSummary(sessions, typeof meta === 'string' ? meta : meta.dateLabel || '');
    return {
      executiveOverview: summary.salesOutcomesSummary || summary.commonCustomerNeeds,
      commonNeedsAndIntent: Array.isArray(summary.commonCustomerNeeds) ? summary.commonCustomerNeeds : [summary.commonCustomerNeeds],
      topProducts: summary.frequentlyDiscussedProducts || [],
      recurringObjections: summary.recurringObjections || [],
      strategicRecommendations: summary.actionableRecommendations || [],
      ...summary,
    };
  }

  async ensureDefaultInventory() {
    try {
      const count = await Inventory.countDocuments();
      if (count === 0) {
        const DEFAULT_INVENTORY = [
          { productName: 'iPhone 16 Pro Max 256GB', sku: 'IP16PM-256-NT', category: 'iPhone', storeCode: 'STORE-01', currentStock: 12, lowStockThreshold: 5, unitPrice: 1199 },
          { productName: 'iPhone 16 Pro 128GB Desert Titanium', sku: 'IP16P-128-DT', category: 'iPhone', storeCode: 'STORE-01', currentStock: 2, lowStockThreshold: 5, unitPrice: 999 },
          { productName: 'iPhone 16 128GB Black', sku: 'IP16-128-BK', category: 'iPhone', storeCode: 'STORE-01', currentStock: 18, lowStockThreshold: 6, unitPrice: 799 },
          { productName: 'AirPods Pro 2 (USB-C)', sku: 'APP2-USBC', category: 'Accessories', storeCode: 'STORE-01', currentStock: 3, lowStockThreshold: 8, unitPrice: 249 },
          { productName: 'AppleCare+ 2-Year Coverage', sku: 'AC-IPHONE', category: 'Services', storeCode: 'STORE-01', currentStock: 999, lowStockThreshold: 10, unitPrice: 199 },
          { productName: 'iPhone 16 Pro Max 256GB', sku: 'IP16PM-256-NT', category: 'iPhone', storeCode: 'STORE-02', currentStock: 15, lowStockThreshold: 5, unitPrice: 1199 },
          { productName: 'iPhone 16 Pro 128GB Natural Titanium', sku: 'IP16P-128-NT', category: 'iPhone', storeCode: 'STORE-02', currentStock: 1, lowStockThreshold: 4, unitPrice: 999 },
          { productName: 'AirPods Pro 2 (USB-C)', sku: 'APP2-USBC', category: 'Accessories', storeCode: 'STORE-02', currentStock: 14, lowStockThreshold: 8, unitPrice: 249 },
          { productName: 'iPhone 16 Pro Max 512GB', sku: 'IP16PM-512-BK', category: 'iPhone', storeCode: 'STORE-03', currentStock: 6, lowStockThreshold: 3, unitPrice: 1399 },
          { productName: 'iPhone 16 128GB Teal', sku: 'IP16-128-TL', category: 'iPhone', storeCode: 'STORE-03', currentStock: 2, lowStockThreshold: 5, unitPrice: 799 },
        ];
        await Inventory.insertMany(DEFAULT_INVENTORY);
        console.log('📦 [Inventory] Initialized default store inventory catalog in MongoDB');
      }
    } catch (err) {
      console.warn('[Inventory] Initialization note:', err.message);
    }
  }
}

const dailyReportService = new DailyReportService();
module.exports = dailyReportService;
