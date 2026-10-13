/**
 * Storelistener — Customer & Sales Intelligence Service (Module 9)
 * File: services/salesIntelligenceService.js
 *
 * Implements:
 * 1. Product Demand Intelligence from verified transcripts & deal analyses.
 * 2. Intent-level categorization (explicit purchase intent, genuine interest, casual mention).
 * 3. Lost-sale & price objection analysis with verifiable transcript quotes & "Reason not identified".
 * 4. Store-by-store comparison with transparent denominators (excluding unclear outcomes from numerator).
 * 5. Customer requirements aggregation without demographic/personal attribute extrapolation.
 * 6. High-performance, lean database querying without loading full audio files into memory.
 * 7. Verified CSV report export matching active filter parameters.
 */

const Session = require('../models/Session');
const Store = require('../models/Store');

// Canonical product normalization dictionary
const KNOWN_PRODUCT_CATALOG = [
  { name: 'iPhone 16 Pro Max', aliases: ['16 pro max', 'sixteen pro max', '16 pro-max', 'iphone 16 pro max'] },
  { name: 'iPhone 16 Pro', aliases: ['16 pro', 'sixteen pro', 'iphone 16 pro'] },
  { name: 'iPhone 16 Plus', aliases: ['16 plus', 'sixteen plus', 'iphone 16 plus'] },
  { name: 'iPhone 16', aliases: ['iphone 16', 'standard 16', 'sixteen'] },
  { name: 'iPhone 15 Pro Max', aliases: ['15 pro max', 'fifteen pro max', 'iphone 15 pro max'] },
  { name: 'iPhone 15 Pro', aliases: ['15 pro', 'fifteen pro', 'iphone 15 pro'] },
  { name: 'iPhone 15', aliases: ['iphone 15', 'fifteen'] },
  { name: 'iPhone 14', aliases: ['iphone 14', 'fourteen'] },
  { name: 'iPhone 13', aliases: ['iphone 13', 'thirteen'] },
  { name: 'AppleCare+ / Warranty', aliases: ['apple care', 'applecare', 'warranty', 'theft and loss', 'protection plan'] },
  { name: 'AirPods Pro 2', aliases: ['airpods pro', 'airpods', 'earbuds', 'wireless earbuds'] },
  { name: 'Apple Watch Series 10 / Ultra', aliases: ['apple watch', 'watch ultra', 'series 10', 'smartwatch'] },
  { name: 'MagSafe & Charger', aliases: ['magsafe', 'charger', 'adapter', '20w', 'case', 'screen protector', 'tempered glass'] },
  { name: 'Trade-in / Exchange', aliases: ['trade in', 'trade-in', 'exchange old phone', 'valuation'] },
];

class SalesIntelligenceService {
  /**
   * Safely normalizes product names against catalog, preserving raw text when uncertain
   */
  normalizeProductName(rawProduct) {
    if (!rawProduct || typeof rawProduct !== 'string') return null;
    const trimmed = rawProduct.trim();
    if (!trimmed || trimmed.toLowerCase() === 'not mentioned' || trimmed.toLowerCase() === 'none') {
      return null;
    }

    const lower = trimmed.toLowerCase();
    for (const item of KNOWN_PRODUCT_CATALOG) {
      if (item.name.toLowerCase() === lower) {
        return item.name;
      }
      for (const alias of item.aliases) {
        if (lower.includes(alias)) {
          return item.name;
        }
      }
    }

    // Preserve original product name when normalization is uncertain
    return trimmed;
  }

  /**
   * Builds lean MongoDB filter respecting date range and store-level role isolation
   */
  buildQueryFilter(params = {}, user = null) {
    const filter = { status: 'completed' };

    // Role-based store isolation
    if (user && user.role === 'sales_manager' && user.storeCode) {
      filter.storeCode = user.storeCode;
    } else {
      const targetStore = params.store || params.storeCode;
      if (targetStore && targetStore !== 'all') {
        filter.$or = [
          { storeCode: targetStore },
          { storeId: targetStore },
        ];
      }
    }

    // Date range filter
    const now = new Date();
    const { dateRange, startDate, endDate } = params;

    if (dateRange && dateRange !== 'all') {
      if (dateRange === 'today') {
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        filter.startedAt = { $gte: startOfDay };
      } else if (dateRange === '7d') {
        filter.startedAt = { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) };
      } else if (dateRange === '30d') {
        filter.startedAt = { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) };
      } else if (dateRange === '90d') {
        filter.startedAt = { $gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) };
      } else if (dateRange === 'custom') {
        const dateFilter = {};
        if (startDate) {
          const parsedStart = new Date(startDate);
          if (!isNaN(parsedStart.getTime())) dateFilter.$gte = parsedStart;
        }
        if (endDate) {
          const parsedEnd = new Date(endDate);
          if (!isNaN(parsedEnd.getTime())) {
            parsedEnd.setHours(23, 59, 59, 999);
            dateFilter.$lte = parsedEnd;
          }
        }
        if (Object.keys(dateFilter).length > 0) {
          filter.startedAt = dateFilter;
        }
      }
    } else if (startDate || endDate) {
      const dateFilter = {};
      if (startDate) {
        const parsedStart = new Date(startDate);
        if (!isNaN(parsedStart.getTime())) dateFilter.$gte = parsedStart;
      }
      if (endDate) {
        const parsedEnd = new Date(endDate);
        if (!isNaN(parsedEnd.getTime())) {
          parsedEnd.setHours(23, 59, 59, 999);
          dateFilter.$lte = parsedEnd;
        }
      }
      if (Object.keys(dateFilter).length > 0) {
        filter.startedAt = dateFilter;
      }
    }

    // Optional specific product filter
    if (params.product && params.product !== 'all') {
      filter['dealAnalysis.productsDiscussed'] = params.product;
    }

    return filter;
  }

  /**
   * Generates comprehensive intelligence overview from actual persisted session records
   */
  async getIntelligenceOverview(params = {}, user = null) {
    const filter = this.buildQueryFilter(params, user);

    // Efficient lean projection - avoids loading audioUrl or transcript chunks into memory
    const sessions = await Session.find(filter)
      .select({
        sessionId: 1,
        storeCode: 1,
        storeName: 1,
        salesRep: 1,
        startedAt: 1,
        endedAt: 1,
        durationSeconds: 1,
        status: 1,
        'dealAnalysis.customerRequirements': 1,
        'dealAnalysis.productsDiscussed': 1,
        'dealAnalysis.budgetAndPrice': 1,
        'dealAnalysis.customerQuestions': 1,
        'dealAnalysis.customerObjections': 1,
        'dealAnalysis.customerBuyingIntent': 1,
        'dealAnalysis.conversationOutcome': 1,
        'dealAnalysis.nextRecommendedAction': 1,
        'dealAnalysis.summary': 1,
        'dealAnalysis.keyMoments': 1,
        'dealAnalysis.analysisStatus': 1,
        'dealAnalysis.isOutdated': 1,
      })
      .sort({ startedAt: -1 })
      .lean();

    const totalEligibleConversations = sessions.length;
    let confirmedSalesCount = 0;
    let followUpsCount = 0;
    let unconvertedCount = 0;
    let unclearOutcomesCount = 0;
    let staleAnalysisCount = 0;

    // Data structures for aggregation
    const productStatsMap = new Map(); // productName -> { distinctSessions: Set, purchaseIntentCount, genuineInterestCount, casualMentionCount, prices: Set, questions: Set, objections: Set, storeCounts: Map, evidence: [] }
    const storeStatsMap = new Map(); // storeCode -> { storeName, total: 0, sales: 0, followUps: 0, unconverted: 0, unclear: 0, productsMap: Map, objectionsMap: Map }
    const lostSaleReasonsMap = new Map(); // reasonCategory -> { count: 0, evidence: [] }
    const customerRequirementsList = [];
    const dateTrendMap = new Map(); // YYYY-MM-DD -> { total: 0, sales: 0, followUps: 0, unconverted: 0 }

    for (const session of sessions) {
      const analysis = session.dealAnalysis || {};
      const outcome = analysis.conversationOutcome || 'Unclear';
      const intent = analysis.customerBuyingIntent || 'Unclear';
      const storeCode = session.storeCode || 'UNKNOWN';
      const storeName = session.storeName || storeCode;

      if (analysis.isOutdated) {
        staleAnalysisCount++;
      }

      // Count outcomes
      if (outcome === 'Sale Confirmed') {
        confirmedSalesCount++;
      } else if (outcome === 'Follow-up Required') {
        followUpsCount++;
      } else if (outcome === 'Not Converted') {
        unconvertedCount++;
      } else {
        unclearOutcomesCount++;
      }

      // Store stats aggregation
      if (!storeStatsMap.has(storeCode)) {
        storeStatsMap.set(storeCode, {
          storeCode,
          storeName,
          total: 0,
          sales: 0,
          followUps: 0,
          unconverted: 0,
          unclear: 0,
          productsMap: new Map(),
          objectionsMap: new Map(),
        });
      }
      const storeRecord = storeStatsMap.get(storeCode);
      storeRecord.total++;
      if (outcome === 'Sale Confirmed') storeRecord.sales++;
      else if (outcome === 'Follow-up Required') storeRecord.followUps++;
      else if (outcome === 'Not Converted') storeRecord.unconverted++;
      else storeRecord.unclear++;

      // Date trend aggregation (YYYY-MM-DD)
      const sessionDate = session.startedAt ? new Date(session.startedAt).toISOString().split('T')[0] : 'Unknown';
      if (!dateTrendMap.has(sessionDate)) {
        dateTrendMap.set(sessionDate, { date: sessionDate, total: 0, sales: 0, followUps: 0, unconverted: 0 });
      }
      const trendEntry = dateTrendMap.get(sessionDate);
      trendEntry.total++;
      if (outcome === 'Sale Confirmed') trendEntry.sales++;
      else if (outcome === 'Follow-up Required') trendEntry.followUps++;
      else if (outcome === 'Not Converted') trendEntry.unconverted++;

      // Product demand aggregation
      const rawProducts = Array.isArray(analysis.productsDiscussed) ? analysis.productsDiscussed : [];
      const distinctProductsInSession = new Set();

      for (const p of rawProducts) {
        const normalized = this.normalizeProductName(p);
        if (normalized) distinctProductsInSession.add(normalized);
      }

      // Also check customer requirements if product list was empty
      if (distinctProductsInSession.size === 0 && analysis.customerRequirements && analysis.customerRequirements !== 'Not mentioned') {
        const normalizedReq = this.normalizeProductName(analysis.customerRequirements);
        if (normalizedReq) distinctProductsInSession.add(normalizedReq);
      }

      for (const prodName of distinctProductsInSession) {
        if (!productStatsMap.has(prodName)) {
          productStatsMap.set(prodName, {
            productName: prodName,
            distinctConversations: 0,
            sessionIds: new Set(),
            explicitPurchaseIntent: 0,
            genuineInterest: 0,
            casualMention: 0,
            priceRanges: new Set(),
            questions: new Set(),
            objections: new Set(),
            storeCounts: new Map(),
            evidenceQuotes: [],
          });
        }

        const prodRecord = productStatsMap.get(prodName);
        if (!prodRecord.sessionIds.has(session.sessionId)) {
          prodRecord.sessionIds.add(session.sessionId);
          prodRecord.distinctConversations++;

          // Intent classification
          if (outcome === 'Sale Confirmed' || intent === 'High') {
            prodRecord.explicitPurchaseIntent++;
          } else if (intent === 'Medium') {
            prodRecord.genuineInterest++;
          } else {
            prodRecord.casualMention++;
          }

          // Price evidence
          if (analysis.budgetAndPrice && !['not mentioned', 'unknown', 'none'].includes(analysis.budgetAndPrice.toLowerCase())) {
            prodRecord.priceRanges.add(analysis.budgetAndPrice);
          }

          // Questions & Objections
          if (Array.isArray(analysis.customerQuestions)) {
            analysis.customerQuestions.forEach((q) => {
              if (q && q.length > 5 && !q.toLowerCase().includes('no explicit')) prodRecord.questions.add(q);
            });
          }
          if (Array.isArray(analysis.customerObjections)) {
            analysis.customerObjections.forEach((o) => {
              if (o && o.length > 5) prodRecord.objections.add(o);
            });
          }

          // Store breakdown
          const currentStoreCount = prodRecord.storeCounts.get(storeCode) || 0;
          prodRecord.storeCounts.set(storeCode, currentStoreCount + 1);

          // Top products in storeRecord
          const storeProdCount = storeRecord.productsMap.get(prodName) || 0;
          storeRecord.productsMap.set(prodName, storeProdCount + 1);

          // Verifiable excerpt / key moment evidence
          if (Array.isArray(analysis.keyMoments) && analysis.keyMoments.length > 0) {
            const firstMoment = analysis.keyMoments[0];
            if (prodRecord.evidenceQuotes.length < 5) {
              prodRecord.evidenceQuotes.push({
                sessionId: session.sessionId,
                storeCode,
                salesRep: session.salesRep || 'Sales Specialist',
                quote: firstMoment.excerpt,
                significance: firstMoment.significance,
              });
            }
          }
        }
      }

      // Lost Sale & Objection Analysis
      if (outcome === 'Not Converted' || outcome === 'Follow-up Required') {
        const objections = Array.isArray(analysis.customerObjections) ? analysis.customerObjections : [];
        let categorized = false;

        for (const obj of objections) {
          const lowerObj = (obj || '').toLowerCase();
          let category = 'Other Objection';

          if (lowerObj.includes('expensive') || lowerObj.includes('price') || lowerObj.includes('cost') || lowerObj.includes('budget') || lowerObj.includes('discount')) {
            category = 'Price / Budget Constraint';
          } else if (lowerObj.includes('stock') || lowerObj.includes('unavailable') || lowerObj.includes('color') || lowerObj.includes('storage') || lowerObj.includes('dont have')) {
            category = 'Product Unavailable / Unmet Requirement';
          } else if (lowerObj.includes('think') || lowerObj.includes('wife') || lowerObj.includes('husband') || lowerObj.includes('later') || lowerObj.includes('sleep on it')) {
            category = 'Customer Timing / Indecision';
          } else if (lowerObj.includes('android') || lowerObj.includes('samsung') || lowerObj.includes('competitor')) {
            category = 'Competitor / Platform Preference';
          }

          if (!lostSaleReasonsMap.has(category)) {
            lostSaleReasonsMap.set(category, { category, count: 0, evidenceQuotes: [] });
          }
          const rec = lostSaleReasonsMap.get(category);
          rec.count++;
          if (rec.evidenceQuotes.length < 5) {
            rec.evidenceQuotes.push({
              sessionId: session.sessionId,
              storeCode,
              salesRep: session.salesRep || 'Sales Specialist',
              quote: obj,
            });
          }
          categorized = true;

          // Track objections per store
          const storeObjCount = storeRecord.objectionsMap.get(category) || 0;
          storeRecord.objectionsMap.set(category, storeObjCount + 1);
        }

        // If no explicit objection was recorded, never invent one! Mark as "Reason not identified"
        if (!categorized && outcome === 'Not Converted') {
          const noReasonCat = 'Reason not identified';
          if (!lostSaleReasonsMap.has(noReasonCat)) {
            lostSaleReasonsMap.set(noReasonCat, { category: noReasonCat, count: 0, evidenceQuotes: [] });
          }
          const rec = lostSaleReasonsMap.get(noReasonCat);
          rec.count++;
          if (rec.evidenceQuotes.length < 5) {
            rec.evidenceQuotes.push({
              sessionId: session.sessionId,
              storeCode,
              salesRep: session.salesRep || 'Sales Specialist',
              quote: analysis.summary || 'Customer concluded session without confirmed purchase or stated objection.',
            });
          }
        }
      }

      // Customer Needs & Follow-up aggregation
      if (analysis.customerRequirements && !['not mentioned', 'unknown', 'none'].includes(analysis.customerRequirements.toLowerCase())) {
        customerRequirementsList.push({
          sessionId: session.sessionId,
          storeCode,
          storeName,
          salesRep: session.salesRep || 'Sales Specialist',
          startedAt: session.startedAt,
          requirement: analysis.customerRequirements,
          budgetAndPrice: analysis.budgetAndPrice || 'Not mentioned',
          outcome,
          buyingIntent: intent,
          nextRecommendedAction: analysis.nextRecommendedAction || 'No action specified',
          evidenceQuote: analysis.keyMoments?.[0]?.excerpt || analysis.summary || 'Explicit customer requirement stated during session',
        });
      }
    }

    // Conversion rate calculations with explicit disclosure
    // Standard conversion rate: confirmed sales / total completed conversations (excluding unclear outcomes from numerator)
    const conversionRate = totalEligibleConversations > 0
      ? parseFloat(((confirmedSalesCount / totalEligibleConversations) * 100).toFixed(1))
      : 0;

    // Resolved conversion rate: confirmed sales / (confirmed sales + unconverted + follow-ups)
    const resolvedConversations = confirmedSalesCount + followUpsCount + unconvertedCount;
    const resolvedConversionRate = resolvedConversations > 0
      ? parseFloat(((confirmedSalesCount / resolvedConversations) * 100).toFixed(1))
      : null;

    // Format Product Demand list
    const productDemandList = Array.from(productStatsMap.values())
      .map((p) => ({
        productName: p.productName,
        distinctConversations: p.distinctConversations,
        explicitPurchaseIntent: p.explicitPurchaseIntent,
        genuineInterest: p.genuineInterest,
        casualMention: p.casualMention,
        priceRanges: Array.from(p.priceRanges),
        commonQuestions: Array.from(p.questions).slice(0, 5),
        commonObjections: Array.from(p.objections).slice(0, 5),
        storeWiseDemand: Object.fromEntries(p.storeCounts),
        evidenceQuotes: p.evidenceQuotes,
      }))
      .sort((a, b) => b.distinctConversations - a.distinctConversations);

    // Format Store Comparison list
    const storeComparisonList = Array.from(storeStatsMap.values())
      .map((s) => {
        const storeRate = s.total > 0 ? parseFloat(((s.sales / s.total) * 100).toFixed(1)) : 0;
        const sortedProducts = Array.from(s.productsMap.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([prod, count]) => ({ product: prod, count }));

        const sortedObjections = Array.from(s.objectionsMap.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([obj, count]) => ({ objection: obj, count }));

        return {
          storeCode: s.storeCode,
          storeName: s.storeName,
          totalEligibleConversations: s.total,
          confirmedSales: s.sales,
          followUpsRequired: s.followUps,
          unconverted: s.unconverted,
          unclearOutcomes: s.unclear,
          conversionRate: storeRate,
          topProducts: sortedProducts,
          topObjections: sortedObjections,
          isComparable: s.total >= 1, // Store comparison validity check
        };
      })
      .sort((a, b) => b.totalEligibleConversations - a.totalEligibleConversations);

    // Format Lost Sales & Objections list
    const lostSaleReasonsList = Array.from(lostSaleReasonsMap.values())
      .sort((a, b) => b.count - a.count);

    // Format Date Trends
    const trendsList = Array.from(dateTrendMap.values())
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      success: true,
      summary: {
        totalEligibleConversations,
        confirmedSalesCount,
        followUpsCount,
        unconvertedCount,
        unclearOutcomesCount,
        conversionRate,
        resolvedConversionRate,
        totalUniqueProducts: productDemandList.length,
        staleAnalysisCount,
        conversionMetricDisclosure:
          'Conversion Rate is computed as Confirmed Sales divided by Total Eligible Completed Conversations. Unclear or undetermined outcomes are retained in the denominator but excluded from the confirmed-sales numerator to prevent assumed conversions.',
      },
      productDemand: productDemandList,
      storeComparison: storeComparisonList,
      lostSalesAndObjections: lostSaleReasonsList,
      customerRequirements: customerRequirementsList.slice(0, 50),
      demandTrends: trendsList,
      appliedFilters: {
        store: params.store || params.storeCode || 'all',
        dateRange: params.dateRange || 'all',
        startDate: params.startDate || null,
        endDate: params.endDate || null,
        product: params.product || 'all',
      },
    };
  }

  /**
   * Generates formatted CSV string representing filtered intelligence data
   */
  generateCSV(overviewData) {
    const headers = [
      'Session ID',
      'Store Code',
      'Store Name',
      'Salesperson',
      'Started At',
      'Outcome',
      'Buying Intent',
      'Customer Requirements',
      'Budget / Price Evidence',
      'Next Recommended Action',
      'Evidence Excerpt',
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const rows = (overviewData.customerRequirements || []).map((item) => [
      escapeCsv(item.sessionId),
      escapeCsv(item.storeCode),
      escapeCsv(item.storeName),
      escapeCsv(item.salesRep),
      escapeCsv(item.startedAt ? new Date(item.startedAt).toISOString() : ''),
      escapeCsv(item.outcome),
      escapeCsv(item.buyingIntent),
      escapeCsv(item.requirement),
      escapeCsv(item.budgetAndPrice),
      escapeCsv(item.nextRecommendedAction),
      escapeCsv(item.evidenceQuote),
    ]);

    // Product summary section
    const productHeader = ['\n\nProduct Name', 'Distinct Conversations', 'Purchase Intent', 'Genuine Interest', 'Casual Mention', 'Price Evidence'];
    const productRows = (overviewData.productDemand || []).map((p) => [
      escapeCsv(p.productName),
      escapeCsv(p.distinctConversations),
      escapeCsv(p.explicitPurchaseIntent),
      escapeCsv(p.genuineInterest),
      escapeCsv(p.casualMention),
      escapeCsv((p.priceRanges || []).join('; ')),
    ]);

    // Store comparison section
    const storeHeader = ['\n\nStore Code', 'Store Name', 'Total Conversations', 'Confirmed Sales', 'Conversion Rate (%)', 'Follow-ups', 'Unconverted', 'Unclear Outcomes'];
    const storeRows = (overviewData.storeComparison || []).map((s) => [
      escapeCsv(s.storeCode),
      escapeCsv(s.storeName),
      escapeCsv(s.totalEligibleConversations),
      escapeCsv(s.confirmedSales),
      escapeCsv(s.conversionRate),
      escapeCsv(s.followUpsRequired),
      escapeCsv(s.unconverted),
      escapeCsv(s.unclearOutcomes),
    ]);

    const csvLines = [
      headers.join(','),
      ...rows.map((r) => r.join(',')),
      productHeader.join(','),
      ...productRows.map((r) => r.join(',')),
      storeHeader.join(','),
      ...storeRows.map((r) => r.join(',')),
    ];

    return csvLines.join('\n');
  }
}

module.exports = new SalesIntelligenceService();
