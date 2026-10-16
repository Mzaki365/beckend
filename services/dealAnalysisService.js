/**
 * Storelistener — Conversation and Deal Analysis Service (Module 6)
 * File: services/dealAnalysisService.js
 *
 * Implements:
 * 1. AI-powered and deterministic transcript analysis for completed retail sessions
 * 2. Extraction of customer requirements, products, budget/price, objections, buying intent,
 *    salesperson responses, deal outcome, recommended follow-up, and key moments.
 * 3. Strict accuracy: never invents sales, prices, or products. Unmentioned items are 'Not mentioned'.
 * 4. Version hashing to prevent duplicate analysis jobs and detect outdated transcripts.
 * 5. Safe handling of empty sessions and unconfigured external AI providers.
 */

require('dotenv').config();
const crypto = require('crypto');
const Session = require('../models/Session');

// Known iPhone catalog & accessories
const PRODUCT_CATALOG = [
  { name: 'iPhone 16 Pro Max', matches: ['16 pro max', 'sixteen pro max', '16 pro-max', 'iphone 16 pro max'] },
  { name: 'iPhone 16 Pro', matches: ['16 pro', 'sixteen pro', 'iphone 16 pro'] },
  { name: 'iPhone 16 Plus', matches: ['16 plus', 'sixteen plus', 'iphone 16 plus'] },
  { name: 'iPhone 16', matches: ['iphone 16', 'standard 16', 'sixteen'] },
  { name: 'iPhone 15 Pro Max', matches: ['15 pro max', 'fifteen pro max', 'iphone 15 pro max'] },
  { name: 'iPhone 15 Pro', matches: ['15 pro', 'fifteen pro', 'iphone 15 pro'] },
  { name: 'iPhone 15', matches: ['iphone 15', 'fifteen'] },
  { name: 'iPhone 14', matches: ['iphone 14', 'fourteen'] },
  { name: 'iPhone 13', matches: ['iphone 13', 'thirteen'] },
  { name: 'AppleCare+ / Warranty', matches: ['apple care', 'applecare', 'warranty', 'theft and loss', 'accidental damage'] },
  { name: 'AirPods Pro 2', matches: ['airpods pro', 'airpods', 'earbuds'] },
  { name: 'Apple Watch Series 10 / Ultra', matches: ['apple watch', 'watch ultra', 'series 10', 'smartwatch'] },
  { name: 'MagSafe & Charger', matches: ['magsafe', 'charger', 'adapter', '20w', 'case', 'screen protector', 'tempered glass'] },
  { name: 'Trade-in / Exchange', matches: ['trade in', 'trade-in', 'exchange old phone', 'valuation'] },
];

// Phrases indicating an actual completed purchase transaction (confirmed sale)
const EXPLICIT_SALE_PHRASES = [
  "i'll take it", 'ill take it', "i will take it", "i'll buy it", 'ill buy it',
  'ring it up', 'wrap it up', 'pay by card', 'card payment', 'credit card',
  'insert your card', 'swipe your card', 'heres my card', "here's my card",
  'heres the receipt', "here's the receipt", 'receipt', 'invoice is ready',
  'bag this up', 'deal done', 'deal is closed', 'congratulations on your new iphone',
  'payment successful', 'paid in full', 'finance approved', 'charge my card',
  'paid by apple pay', 'apple pay approved'
];

// Phrases indicating customer wants follow-up or needs time
const FOLLOW_UP_PHRASES = [
  'need to think', 'come back later', 'talk to my wife', 'talk to my husband',
  'sleep on it', 'send me a quote', 'give me your card', 'call me back',
  'consult', 'check my budget', 'come back tomorrow', 'return this weekend'
];

// Phrases indicating rejection / walkaway without purchase
const NOT_CONVERTED_PHRASES = [
  'too expensive', 'out of my budget', 'cannot afford', 'cant afford',
  'just looking', 'just browsing', 'browsing', 'only looking', 'not interested', 'way too much', 'walk away',
  'too costly', 'pass on this', 'no thanks'
];

// Objections taxonomy
const OBJECTION_PATTERNS = [
  { type: 'Price / Budget', keywords: ['too expensive', 'high price', 'costly', 'out of budget', 'discount', 'cheaper'] },
  { type: 'Trade-in Value', keywords: ['trade in is low', 'expected more', 'lowball', 'trade-in value'] },
  { type: 'Hesitation / Need Time', keywords: ['need to think', 'come back later', 'discuss at home', 'just browsing', 'not sure yet'] },
  { type: 'Storage / Specs', keywords: ['storage', '128gb', '256gb', 'battery life', 'camera', 'screen size'] },
  { type: 'Color / Stock Availability', keywords: ['out of stock', 'natural titanium', 'desert titanium', 'black titanium', 'backorder'] }
];

class DealAnalysisService {
  /**
   * Computes a deterministic MD5 hash of transcript dialogue
   */
  computeTranscriptHash(transcripts = []) {
    if (!Array.isArray(transcripts) || transcripts.length === 0) return 'empty';
    const normalized = transcripts
      .map((t) => `${(t.speaker || '').toLowerCase()}:${(t.text || '').trim().toLowerCase()}`)
      .join('|');
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  /**
   * Extracts prices, budgets, or payment amounts mentioned in text
   */
  extractBudgetAndPrices(fullText) {
    if (!fullText) return 'Not mentioned';

    // Regex for dollar values (e.g. $1,199, $999, $45/mo)
    const dollarMatches = fullText.match(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)(?:\s*(?:\/mo|per month))?/gi);
    if (dollarMatches && dollarMatches.length > 0) {
      // Remove duplicates
      const unique = Array.from(new Set(dollarMatches.map((m) => m.trim())));
      return unique.join(', ');
    }

    // Regex for spelled out numbers with currency words
    const numWords = fullText.match(/(\d+(?:,\d{3})*)\s*(?:dollars|bucks|usd)/gi);
    if (numWords && numWords.length > 0) {
      const unique = Array.from(new Set(numWords.map((m) => m.trim())));
      return unique.join(', ');
    }

    return 'Not mentioned';
  }

  /**
   * Extracts customer requirements and product interests from dialogue
   */
  extractCustomerRequirements(transcripts = []) {
    const customerLines = transcripts.filter(
      (t) => (t.speaker || '').toLowerCase() === 'customer'
    );

    if (customerLines.length === 0) return 'Not mentioned';

    const requirements = [];
    const customerText = customerLines.map((t) => t.englishText || t.text).join(' ');
    const lower = customerText.toLowerCase();

    if (lower.includes('upgrade') || lower.includes('old phone')) {
      requirements.push('Device upgrade evaluation');
    }
    if (lower.includes('camera') || lower.includes('photo') || lower.includes('zoom')) {
      requirements.push('Enhanced camera & photography capabilities');
    }
    if (lower.includes('battery') || lower.includes('charge')) {
      requirements.push('Longer battery endurance');
    }
    if (lower.includes('storage') || lower.includes('gigabyte') || lower.includes('gb') || lower.includes('icloud')) {
      requirements.push('Higher internal storage capacity');
    }
    if (lower.includes('trade in') || lower.includes('trade-in')) {
      requirements.push('Trading in existing smartphone for trade-in credit');
    }
    if (lower.includes('monthly') || lower.includes('financing') || lower.includes('installment')) {
      requirements.push('Monthly carrier financing / installment plan');
    }

    // Check specific products asked for
    for (const prod of PRODUCT_CATALOG) {
      if (prod.matches.some((m) => lower.includes(m))) {
        requirements.push(`Interest in ${prod.name}`);
        break;
      }
    }

    if (requirements.length > 0) {
      return Array.from(new Set(requirements)).join('; ');
    }

    // Extract first customer inquiry sentence
    const firstQuestion = customerLines.find((l) => (l.text || '').includes('?') || (l.text || '').length > 15);
    if (firstQuestion) {
      return firstQuestion.text.slice(0, 140);
    }

    return 'General product exploration';
  }

  /**
   * Identifies products discussed
   */
  extractProductsDiscussed(fullText) {
    if (!fullText) return [];
    const lower = fullText.toLowerCase();
    const discussed = [];

    for (const prod of PRODUCT_CATALOG) {
      if (prod.matches.some((m) => lower.includes(m))) {
        discussed.push(prod.name);
      }
    }

    return Array.from(new Set(discussed));
  }

  /**
   * Identifies customer questions and objections
   */
  extractQuestionsAndObjections(transcripts = []) {
    const customerLines = transcripts.filter(
      (t) => (t.speaker || '').toLowerCase() === 'customer'
    );

    const questions = [];
    const objections = [];

    for (const line of customerLines) {
      const text = (line.text || '').trim();
      const lower = text.toLowerCase();

      // Check questions
      if (text.includes('?') || lower.startsWith('how') || lower.startsWith('what') || lower.startsWith('is ') || lower.startsWith('can ') || lower.startsWith('do you')) {
        if (!questions.includes(text) && text.length > 8 && questions.length < 5) {
          questions.push(text);
        }
      }

      // Check objections
      for (const obj of OBJECTION_PATTERNS) {
        if (obj.keywords.some((k) => lower.includes(k))) {
          if (!objections.includes(obj.type)) {
            objections.push(obj.type);
          }
        }
      }
    }

    return {
      questions: questions.length > 0 ? questions : ['No explicit customer questions recorded'],
      objections: objections.length > 0 ? objections : []
    };
  }

  /**
   * Identifies salesperson's responses to customer questions and objections
   */
  extractSalespersonResponse(transcripts = [], objections = []) {
    const salesLines = transcripts.filter(
      (t) => (t.speaker || '').toLowerCase().includes('sales') || (t.speaker || '').toLowerCase().includes('employee')
    );

    if (salesLines.length === 0) return 'Not mentioned';

    if (objections.length === 0) {
      const firstHelpful = salesLines.find((l) => (l.englishText || l.text || '').length > 20);
      return firstHelpful ? `Provided consultation: "${firstHelpful.englishText || firstHelpful.text}"` : 'Provided consultative product overview.';
    }

    // Look for responses that address price, financing, trade-in, or features
    const responseHints = [];
    const salesText = salesLines.map((l) => l.englishText || l.text).join(' ');
    const lower = salesText.toLowerCase();

    if (lower.includes('financing') || lower.includes('monthly') || lower.includes('0%')) {
      responseHints.push('Offered 0% APR monthly financing options');
    }
    if (lower.includes('trade in') || lower.includes('credit') || lower.includes('value')) {
      responseHints.push('Presented trade-in program to reduce upfront cost');
    }
    if (lower.includes('applecare') || lower.includes('warranty')) {
      responseHints.push('Explained AppleCare+ protection coverage');
    }
    if (lower.includes('spec') || lower.includes('camera') || lower.includes('chip') || lower.includes('battery')) {
      responseHints.push('Clarified technical hardware differences & value proposition');
    }

    if (responseHints.length > 0) {
      return responseHints.join('; ');
    }

    return 'Addressed customer questions with product details and recommendations.';
  }

  /**
   * Classifies buying intent based strictly on dialogue evidence
   */
  classifyBuyingIntent(fullText, closingSignalsCount, objectionsCount) {
    const lower = (fullText || '').toLowerCase();

    // High: explicitly preparing to purchase, payment, or strong readiness
    const hasHighIntent =
      closingSignalsCount > 0 ||
      lower.includes('ill buy') ||
      lower.includes("i'll buy") ||
      lower.includes('take it') ||
      lower.includes('credit card') ||
      lower.includes('ready to pay') ||
      lower.includes('buy today');

    if (hasHighIntent) return 'High';

    // Low: explicit rejection, walking away, lack of interest
    const hasLowIntent =
      NOT_CONVERTED_PHRASES.some((p) => lower.includes(p)) ||
      (objectionsCount >= 2 && !lower.includes('trade in') && !lower.includes('installment'));

    if (hasLowIntent) return 'Low';

    // Medium: asking questions about price, specs, trade-in, financing
    const hasMediumIntent =
      lower.includes('how much') ||
      lower.includes('price') ||
      lower.includes('trade in') ||
      lower.includes('difference between') ||
      lower.includes('warranty');

    if (hasMediumIntent) return 'Medium';

    return 'Unclear';
  }

  /**
   * Classifies conversation outcome:
   * 'Sale Confirmed' | 'Follow-up Required' | 'Not Converted' | 'Unclear'
   *
   * Crucial rule: Never label a conversation as a confirmed sale unless an explicit
   * closing statement, payment, receipt, or agreement to buy took place.
   */
  classifyOutcome(fullText, transcripts = []) {
    const lower = (fullText || '').toLowerCase();

    // 1. Check for genuine confirmed sale
    const isExplicitSale = EXPLICIT_SALE_PHRASES.some((phrase) => lower.includes(phrase));
    if (isExplicitSale) {
      return 'Sale Confirmed';
    }

    // 2. Check for follow-up required
    const isFollowUp = FOLLOW_UP_PHRASES.some((phrase) => lower.includes(phrase));
    if (isFollowUp) {
      return 'Follow-up Required';
    }

    // 3. Check for unconverted
    const isNotConverted = NOT_CONVERTED_PHRASES.some((phrase) => lower.includes(phrase));
    if (isNotConverted) {
      return 'Not Converted';
    }

    // If dialogue is short or inconclusive
    if (transcripts.length < 3) {
      return 'Unclear';
    }

    // If customer asked prices but didn't buy or explicitly leave
    if (lower.includes('price') || lower.includes('cost') || lower.includes('how much')) {
      return 'Follow-up Required';
    }

    return 'Unclear';
  }

  /**
   * Generates actionable recommended next step
   */
  generateNextAction(outcome, buyingIntent, products = []) {
    const prodName = products[0] || 'iPhone';

    switch (outcome) {
      case 'Sale Confirmed':
        return `Assist customer with iCloud transfer setup, verify AppleCare+ activation, and recommend protective accessories.`;
      case 'Follow-up Required':
        return `Send digital quotation and trade-in estimate link for ${prodName} via SMS within 2 hours while purchase intent is warm.`;
      case 'Not Converted':
        return `Record feedback regarding price sensitivity; notify customer if upcoming promotional financing or carrier credits become available.`;
      default:
        return buyingIntent === 'High' || buyingIntent === 'Medium'
          ? `Follow up with customer regarding ${prodName} specifications and available stock options.`
          : `Log general counter consultation into store CRM.`;
    }
  }

  /**
   * Extracts 1-4 key turning moments from the actual dialogue
   */
  extractKeyMoments(transcripts = [], outcome) {
    if (!Array.isArray(transcripts) || transcripts.length === 0) return [];

    const moments = [];

    // 1. Initial inquiry
    const firstCustomer = transcripts.find((t) => (t.speaker || '').toLowerCase() === 'customer');
    if (firstCustomer) {
      moments.push({
        excerpt: firstCustomer.englishText || firstCustomer.text,
        speaker: 'Customer',
        significance: 'Customer initial inquiry / requirement statement'
      });
    }

    // 2. Objection / question moment
    for (const t of transcripts) {
      const lower = (t.englishText || t.text || '').toLowerCase();
      if (OBJECTION_PATTERNS.some((o) => o.keywords.some((k) => lower.includes(k)))) {
        if (!moments.some((m) => m.excerpt === (t.englishText || t.text))) {
          moments.push({
            excerpt: t.englishText || t.text,
            speaker: (t.speaker || '').toLowerCase().includes('sales') ? 'Salesperson' : 'Customer',
            significance: 'Key customer consideration or objection voiced'
          });
          break;
        }
      }
    }

    // 3. Decisive outcome moment
    if (outcome === 'Sale Confirmed') {
      const saleLine = transcripts.find((t) =>
        EXPLICIT_SALE_PHRASES.some((p) => (t.englishText || t.text || '').toLowerCase().includes(p))
      );
      if (saleLine && !moments.some((m) => m.excerpt === (saleLine.englishText || saleLine.text))) {
        moments.push({
          excerpt: saleLine.englishText || saleLine.text,
          speaker: (saleLine.speaker || '').toLowerCase().includes('sales') ? 'Salesperson' : 'Customer',
          significance: 'Sale confirmation and transaction commitment'
        });
      }
    } else {
      const lastLine = transcripts[transcripts.length - 1];
      if (lastLine) {
        moments.push({
          excerpt: lastLine.englishText || lastLine.text,
          speaker: (lastLine.speaker || '').toLowerCase().includes('sales') ? 'Salesperson' : 'Customer',
          significance: 'Closing interaction or departure remark'
        });
      }
    }

    return moments.slice(0, 4);
  }

  /**
   * Deterministic local analysis engine (100% reliable fallback)
   */
  analyzeDeterministic(transcripts = [], metadata = {}) {
    const fullText = transcripts.map((t) => `${(t.speaker || '').toUpperCase()}: ${t.text}`).join('\n');
    const productsDiscussed = this.extractProductsDiscussed(fullText);
    const budgetAndPrice = this.extractBudgetAndPrices(fullText);
    const customerRequirements = this.extractCustomerRequirements(transcripts);
    const { questions, objections } = this.extractQuestionsAndObjections(transcripts);
    const salespersonResponse = this.extractSalespersonResponse(transcripts, objections);
    const conversationOutcome = this.classifyOutcome(fullText, transcripts);
    const customerBuyingIntent = this.classifyBuyingIntent(fullText, conversationOutcome === 'Sale Confirmed' ? 1 : 0, objections.length);
    const nextRecommendedAction = this.generateNextAction(conversationOutcome, customerBuyingIntent, productsDiscussed);
    const keyMoments = this.extractKeyMoments(transcripts, conversationOutcome);

    const productsLabel = productsDiscussed.length > 0 ? productsDiscussed.join(', ') : 'general retail inventory';
    const durationSec = Math.round(metadata.durationSeconds || 0);

    const summary =
      `Customer consulted on ${productsLabel}. ` +
      `Duration was ${durationSec}s. ` +
      (objections.length > 0
        ? `Topics addressed included ${objections.join(', ')}. `
        : `No significant objections were encountered. `) +
      `Outcome concluded as "${conversationOutcome}" with ${customerBuyingIntent} buying intent.`;

    return {
      customerRequirements,
      productsDiscussed,
      budgetAndPrice,
      customerQuestions: questions,
      customerObjections: objections,
      customerBuyingIntent,
      salespersonResponse,
      conversationOutcome,
      nextRecommendedAction,
      summary,
      keyMoments,
    };
  }

  /**
   * AI-powered analysis with Gemini (when API key is present)
   */
  async analyzeWithGemini(transcripts = [], metadata = {}) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const fullDialogue = transcripts
      .map((t) => `${(t.speaker || '').toUpperCase()}: ${t.englishText || t.text}`)
      .join('\n');

    const prompt = `You are a senior Apple Retail Intelligence AI. Analyze the following verified in-store sales conversation transcript:

TRANSCRIPT:
${fullDialogue}

METADATA:
Store: ${metadata.storeName || metadata.storeCode || 'iPhone Store'}
Duration: ${metadata.durationSeconds || 0} seconds
Salesperson: ${metadata.salesRep || 'Sales Specialist'}

CRITICAL ACCURACY INSTRUCTIONS:
1. Base EVERY field strictly on the provided transcript.
2. NEVER invent a product, price, confirmed sale, or requirement that was not stated in the transcript.
3. If price, budget, requirements, or salesperson responses are absent, write "Not mentioned" or "Unknown".
4. Distinguish an actual confirmed sale (customer agreed to purchase, paid, card swiped, receipt issued) from general interest. If no payment or confirmed commitment occurred, do NOT mark "Sale Confirmed".
5. Output ONLY valid, parsable JSON matching this exact structure:

{
  "customerRequirements": "string describing what customer needs or 'Not mentioned'",
  "productsDiscussed": ["array of exact products discussed, e.g. 'iPhone 16 Pro'"],
  "budgetAndPrice": "exact price or budget mentioned or 'Not mentioned'",
  "customerQuestions": ["array of questions asked by customer"],
  "customerObjections": ["array of customer hesitations/objections or empty array"],
  "customerBuyingIntent": "High" | "Medium" | "Low" | "Unclear",
  "salespersonResponse": "how salesperson handled customer concerns or 'Not mentioned'",
  "conversationOutcome": "Sale Confirmed" | "Follow-up Required" | "Not Converted" | "Unclear",
  "nextRecommendedAction": "actionable next step for the sales specialist",
  "summary": "concise 2-3 sentence overview of the conversation",
  "keyMoments": [
    {
      "excerpt": "exact quote from transcript",
      "speaker": "Customer" | "Salesperson",
      "significance": "why this moment was important"
    }
  ]
}`;

    const models = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];
    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText) {
            const parsed = JSON.parse(rawText);
            // Validate essential fields
            if (parsed.summary && parsed.conversationOutcome && parsed.customerBuyingIntent) {
              return parsed;
            }
          }
        }
      } catch (err) {
        // Try fallback model
      }
    }

    return null;
  }

  /**
   * Main entry point: runs complete analysis for a session and saves result to MongoDB
   */
  async runAnalysisForSession(sessionId, options = { force: false }) {
    if (!sessionId) {
      throw new Error('sessionId is required for deal analysis');
    }

    const session = await Session.findOne({ sessionId });
    if (!session) {
      throw new Error(`Session with ID "${sessionId}" not found in database`);
    }

    const transcripts = session.transcripts || [];

    // Empty or unusable transcript check
    const usableLines = transcripts.filter((t) => t.text && t.text.trim().length > 0);
    if (usableLines.length === 0) {
      const emptyResult = {
        customerRequirements: 'Not mentioned',
        productsDiscussed: [],
        budgetAndPrice: 'Not mentioned',
        customerQuestions: [],
        customerObjections: [],
        customerBuyingIntent: 'Unclear',
        salespersonResponse: 'Not mentioned',
        conversationOutcome: 'Unclear',
        salesOutcome: 'Inconclusive',
        outcomeExplanation: 'Session contains no usable dialogue transcript content to evaluate outcome.',
        nextRecommendedAction: 'No dialogue recorded; verify terminal microphone status.',
        summary: 'Session contains no usable dialogue transcript content.',
        keyMoments: [],
        analysisStatus: 'empty_skipped',
        analysisError: null,
        transcriptVersionHash: 'empty',
        lastAnalyzedAt: new Date(),
        isOutdated: false,
      };

      session.dealAnalysis = emptyResult;
      await session.save();
      return emptyResult;
    }

    // Version hashing to prevent redundant duplicate analysis
    const currentHash = this.computeTranscriptHash(transcripts);
    if (
      !options.force &&
      session.dealAnalysis?.analysisStatus === 'completed' &&
      session.dealAnalysis?.transcriptVersionHash === currentHash
    ) {
      console.log(`ℹ️ [Deal Analysis] Session ${sessionId} already analyzed with current transcript version.`);
      return session.dealAnalysis;
    }

    // Set status to analyzing
    session.dealAnalysis = {
      ...(session.dealAnalysis || {}),
      analysisStatus: 'analyzing',
      analysisError: null,
    };
    await session.save();

    try {
      const metadata = {
        storeName: session.storeName,
        storeCode: session.storeCode,
        salesRep: session.salesRep,
        durationSeconds: session.durationSeconds,
      };

      // 1. Try Gemini AI analysis first if configured
      let analysisResult = null;
      if (process.env.GEMINI_API_KEY && usableLines.length >= 2) {
        analysisResult = await this.analyzeWithGemini(usableLines, metadata);
      }

      // 2. Fall back to deterministic retail analysis engine
      if (!analysisResult) {
        analysisResult = this.analyzeDeterministic(usableLines, metadata);
      }

      const outcome = ['Sale Confirmed', 'Follow-up Required', 'Not Converted', 'Unclear'].includes(analysisResult.conversationOutcome)
        ? analysisResult.conversationOutcome
        : 'Unclear';

      const salesOutcome =
        outcome === 'Sale Confirmed'
          ? 'Won'
          : outcome === 'Not Converted'
          ? 'Lost'
          : outcome === 'Follow-up Required'
          ? 'Pending'
          : 'Inconclusive';

      const outcomeExplanation =
        outcome === 'Sale Confirmed'
          ? 'Customer confirmed purchase transaction with payment or explicit agreement to purchase.'
          : outcome === 'Not Converted'
          ? 'Customer walked away, rejected the offer, or cited prohibitive budget constraints without purchasing.'
          : outcome === 'Follow-up Required'
          ? 'Customer expressed purchase intent but requested time to consult or scheduled a follow-up consultation; transaction pending.'
          : 'Dialogue ended without explicit transaction or closure statement.';

      // Format final subdocument
      const finalAnalysis = {
        customerRequirements: analysisResult.customerRequirements || 'Not mentioned',
        productsDiscussed: Array.isArray(analysisResult.productsDiscussed) ? analysisResult.productsDiscussed : [],
        budgetAndPrice: analysisResult.budgetAndPrice || 'Not mentioned',
        customerQuestions: Array.isArray(analysisResult.customerQuestions) ? analysisResult.customerQuestions : [],
        customerObjections: Array.isArray(analysisResult.customerObjections) ? analysisResult.customerObjections : [],
        customerBuyingIntent: ['High', 'Medium', 'Low', 'Unclear'].includes(analysisResult.customerBuyingIntent)
          ? analysisResult.customerBuyingIntent
          : 'Unclear',
        salespersonResponse: analysisResult.salespersonResponse || 'Not mentioned',
        conversationOutcome: outcome,
        salesOutcome,
        outcomeExplanation,
        nextRecommendedAction: analysisResult.nextRecommendedAction || 'Not mentioned',
        summary: analysisResult.summary || 'Not mentioned',
        keyMoments: Array.isArray(analysisResult.keyMoments) ? analysisResult.keyMoments : [],
        analysisStatus: 'completed',
        analysisError: null,
        transcriptVersionHash: currentHash,
        lastAnalyzedAt: new Date(),
        isOutdated: false,
      };

      // Also sync legacy analytics fields for compatibility
      session.dealAnalysis = finalAnalysis;
      if (session.analytics) {
        session.analytics.dealOutcome =
          finalAnalysis.conversationOutcome === 'Sale Confirmed'
            ? 'won'
            : finalAnalysis.conversationOutcome === 'Not Converted'
            ? 'lost'
            : finalAnalysis.conversationOutcome === 'Follow-up Required'
            ? 'in_negotiation'
            : 'inquiry_only';
        session.analytics.summary = finalAnalysis.summary;
        session.analytics.devicesDiscussed = finalAnalysis.productsDiscussed;
      }

      await session.save();
      console.log(`✅ [Deal Analysis] Analysis generated & persisted for session: ${sessionId} (${finalAnalysis.conversationOutcome})`);

      return finalAnalysis;
    } catch (err) {
      console.error(`❌ [Deal Analysis] Error analyzing session ${sessionId}:`, err.message);
      const failedState = {
        ...(session.dealAnalysis || {}),
        analysisStatus: 'failed',
        analysisError: err.message,
        lastAnalyzedAt: new Date(),
      };
      session.dealAnalysis = failedState;
      await session.save();
      throw err;
    }
  }
}

const dealAnalysisService = new DealAnalysisService();
module.exports = dealAnalysisService;
