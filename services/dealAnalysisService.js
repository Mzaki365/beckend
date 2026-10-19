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
   * Extracts individual prices from a single conversational turn
   */
  extractTurnPrices(text) {
    if (!text) return [];
    const prices = [];
    const dollarRegex = /\$\s*(\d+(?:\.\d{1,2})?)/g;
    let match;
    while ((match = dollarRegex.exec(text)) !== null) {
      const val = parseFloat(match[1]);
      if (!isNaN(val)) prices.push(val);
    }
    const wordRegex = /\b(\d+(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b/gi;
    while ((match = wordRegex.exec(text)) !== null) {
      const val = parseFloat(match[1]);
      if (!isNaN(val) && !prices.includes(val)) prices.push(val);
    }
    return prices;
  }

  /**
   * Extracts multi-product price breakdowns from a single or combined conversational turn
   */
  extractMultiProductPrices(text) {
    if (!text) return [];
    const items = [];
    const productKeywords = [
      { name: 'iPhone', pattern: /iphone/i },
      { name: 'Charger', pattern: /charger|adapter|magsafe/i },
      { name: 'Case', pattern: /case|cover/i },
      { name: 'Screen Protector', pattern: /screen protector|tempered glass/i },
      { name: 'AirPods', pattern: /airpods/i },
      { name: 'Apple Watch', pattern: /watch/i },
    ];

    const clauses = text.split(/\band\b|,|;/i);
    for (const clause of clauses) {
      const prices = this.extractTurnPrices(clause);
      if (prices.length > 0) {
        let matched = null;
        for (const pk of productKeywords) {
          if (pk.pattern.test(clause)) {
            matched = pk.name;
            break;
          }
        }
        if (matched) {
          items.push({ name: matched, price: prices[0], quantity: 1 });
        }
      }
    }

    if (items.length >= 2) {
      return items;
    }

    const allPrices = this.extractTurnPrices(text);
    if (allPrices.length >= 2) {
      const matchedNames = [];
      for (const pk of productKeywords) {
        if (pk.pattern.test(text) && !matchedNames.includes(pk.name)) {
          matchedNames.push(pk.name);
        }
      }
      if (matchedNames.length >= allPrices.length) {
        return allPrices.map((price, idx) => ({
          name: matchedNames[idx] || `Item ${idx + 1}`,
          price,
          quantity: 1,
        }));
      }
    }

    return items;
  }

  /**
   * Evaluates complete retail conversation for negotiation dynamics, deal outcome & agreed price
   */
  analyzeDealNegotiation(transcripts = []) {
    if (!Array.isArray(transcripts) || transcripts.length === 0) {
      return {
        dealStatus: 'no_opportunity',
        salesOutcome: 'Inconclusive',
        customerCommitted: false,
        initialAskingPrice: null,
        customerOffer: null,
        agentCounterOffer: null,
        finalAgreedPrice: null,
        agreedDealValue: 0,
        realizedRevenue: 0,
        currency: 'USD',
        isPriceVerified: false,
        isMissedOpportunity: false,
        missedOpportunityReason: null,
        products: [],
        evidenceExcerpts: [],
        reviewFlags: ['no_dialogue'],
      };
    }

    let initialAskingPrice = null;
    const customerOffers = [];
    const agentOffers = [];
    let agentAgreedPrice = null;
    let agentRefused = false;
    let customerCommitted = false;
    let customerWithdrew = false;
    let customerPending = false;
    let customerRejected = false;
    let multiProducts = [];
    const evidenceExcerpts = [];
    const reviewFlags = [];

    const fullText = transcripts.map((t) => `${(t.speaker || '').toUpperCase()}: ${t.englishText || t.text || ''}`).join('\n');
    const lowerFull = fullText.toLowerCase();

    // Check if there are any products discussed
    const productsDiscussed = this.extractProductsDiscussed(fullText);

    for (const t of transcripts) {
      const rawSpeaker = (t.speaker || '').toLowerCase();
      const isRep = rawSpeaker.includes('sales') || rawSpeaker.includes('employee') || rawSpeaker.includes('rep') || rawSpeaker.includes('agent');
      const isCustomer = rawSpeaker.includes('customer') || rawSpeaker.includes('client') || (!isRep && rawSpeaker.includes('user'));
      const text = (t.englishText || t.text || '').trim();
      const lower = text.toLowerCase();

      const prices = this.extractTurnPrices(text);
      const multi = this.extractMultiProductPrices(text);
      if (multi.length >= 2) {
        multiProducts = multi;
      }

      if (isRep) {
        if (prices.length > 0) {
          if (initialAskingPrice === null && customerOffers.length === 0) {
            initialAskingPrice = prices[0];
          }

          // Check if rep accepts customer's offer
          const isAgreePhrase = /\b(okay|ok|yes|deal|sure|fine|done|i can do|we can do)\b/i.test(lower);
          const isRefusePhrase = /\b(sorry|cannot|can't|cant|no|minimum|lowest|firm)\b/i.test(lower);

          if (isRefusePhrase) {
            agentRefused = true;
            agentOffers.push(prices[0]);
            evidenceExcerpts.push({ excerpt: text, role: 'sales_rep', reason: 'Sales rep refused customer offer / counter-offered' });
          } else if (isAgreePhrase) {
            agentAgreedPrice = prices[0];
            evidenceExcerpts.push({ excerpt: text, role: 'sales_rep', reason: 'Sales rep agreed to negotiated price' });
          } else {
            agentOffers.push(prices[0]);
          }
        }
      } else if (isCustomer) {
        // Customer turn
        const isCommitPhrase = /\b(pack it|pack them|pack it up|i'll take it|ill take it|i will take it|ring it up|wrap it up|charge my card|here's my card|heres my card|take my money|buy it)\b/i.test(lower);
        const isWithdrawPhrase = /\b(wait|never mind|nevermind|cancel|cannot afford|cant afford|changed my mind|take it back|actually no)\b/i.test(lower);
        const isPendingPhrase = /\b(think about it|need to think|let me think|come back later|talk to my wife|talk to my husband|sleep on it|consult)\b/i.test(lower);
        const isRejectPhrase = /\b(don't want|dont want|no thanks|too expensive|too much|pass on|not interested|forget it|no deal)\b/i.test(lower);

        if (isWithdrawPhrase) {
          customerWithdrew = true;
          customerCommitted = false;
          evidenceExcerpts.push({ excerpt: text, role: 'customer', reason: 'Customer withdrew acceptance' });
        } else if (isRejectPhrase) {
          customerRejected = true;
          customerCommitted = false;
          evidenceExcerpts.push({ excerpt: text, role: 'customer', reason: 'Customer rejected product or price' });
        } else if (isPendingPhrase) {
          customerPending = true;
          customerCommitted = false;
          evidenceExcerpts.push({ excerpt: text, role: 'customer', reason: 'Customer requested time to consider' });
        } else if (isCommitPhrase) {
          customerCommitted = true;
          customerPending = false;
          customerRejected = false;
          customerWithdrew = false;
          evidenceExcerpts.push({ excerpt: text, role: 'customer', reason: 'Customer accepted deal' });
        }

        if (prices.length > 0) {
          customerOffers.push(prices[0]);
          evidenceExcerpts.push({ excerpt: text, role: 'customer', reason: 'Customer proposed offer price' });
        }
      }
    }

    // Determine dealStatus and financials
    let dealStatus = 'unknown';
    let salesOutcome = 'Inconclusive';
    let finalAgreedPrice = null;
    let agreedDealValue = 0;
    let realizedRevenue = 0;
    let isPriceVerified = false;
    let isMissedOpportunity = false;
    let missedOpportunityReason = null;
    let finalProducts = [];

    if (multiProducts.length >= 2) {
      finalProducts = multiProducts;
    } else if (productsDiscussed.length > 0) {
      finalProducts = productsDiscussed.map((name) => ({ name, price: null, quantity: 1 }));
    }

    // 1. Withdrawal
    if (customerWithdrew) {
      dealStatus = 'lost';
      salesOutcome = 'Lost';
      agreedDealValue = 0;
      realizedRevenue = 0;
      isMissedOpportunity = true;
      missedOpportunityReason = (agentRefused || customerOffers.length > 0 || lowerFull.includes('afford') || lowerFull.includes('expensive'))
        ? 'price_disagreement'
        : 'customer_rejection';
    }
    // 2. Customer Rejection or Agent Refusal that ended without sale
    else if (customerRejected || (agentRefused && !customerCommitted)) {
      dealStatus = 'lost';
      salesOutcome = 'Lost';
      agreedDealValue = 0;
      realizedRevenue = 0;
      isMissedOpportunity = true;
      missedOpportunityReason = (agentRefused || customerOffers.length > 0 || lowerFull.includes('expensive') || lowerFull.includes('price'))
        ? 'price_disagreement'
        : 'customer_rejection';
    }
    // 3. Pending
    else if (customerPending) {
      dealStatus = 'pending';
      salesOutcome = 'Pending';
      agreedDealValue = 0;
      realizedRevenue = 0;
      customerCommitted = false;
      isMissedOpportunity = false;
      if (agentAgreedPrice !== null) {
        finalAgreedPrice = agentAgreedPrice;
      }
    }
    // 4. Customer Committed / Accepted
    else if (customerCommitted) {
      dealStatus = 'accepted';
      salesOutcome = 'Won';
      isMissedOpportunity = false;

      if (multiProducts.length >= 2) {
        const total = multiProducts.reduce((sum, p) => sum + (p.price || 0), 0);
        finalAgreedPrice = total;
        agreedDealValue = total;
        realizedRevenue = total;
        isPriceVerified = true;
      } else if (agentAgreedPrice !== null) {
        finalAgreedPrice = agentAgreedPrice;
        agreedDealValue = agentAgreedPrice;
        realizedRevenue = agentAgreedPrice;
        isPriceVerified = true;
      } else if (customerOffers.length > 0) {
        const lastOffer = customerOffers[customerOffers.length - 1];
        finalAgreedPrice = lastOffer;
        agreedDealValue = lastOffer;
        realizedRevenue = lastOffer;
        isPriceVerified = true;
      } else if (initialAskingPrice !== null) {
        finalAgreedPrice = initialAskingPrice;
        agreedDealValue = initialAskingPrice;
        realizedRevenue = initialAskingPrice;
        isPriceVerified = true;
      } else {
        // Price unverified (Scenario F)
        isPriceVerified = false;
        finalAgreedPrice = null;
        agreedDealValue = null;
        realizedRevenue = null;
        reviewFlags.push('unverified_price');
      }

      if (finalProducts.length === 1 && typeof finalAgreedPrice === 'number') {
        finalProducts[0].price = finalAgreedPrice;
      }
    }
    // 5. Ambiguous or no sales opportunity established
    else {
      const isSalesConversation = productsDiscussed.length > 0 || initialAskingPrice !== null || customerOffers.length > 0;
      if (!isSalesConversation) {
        dealStatus = 'no_opportunity';
        salesOutcome = 'Inconclusive';
      } else {
        dealStatus = 'unknown';
        salesOutcome = 'Inconclusive';
        reviewFlags.push('inconclusive_outcome');
      }
      agreedDealValue = 0;
      realizedRevenue = 0;
      isMissedOpportunity = false;
    }

    const lastCustomerOffer = customerOffers.length > 0 ? customerOffers[customerOffers.length - 1] : null;
    const lastAgentOffer = agentOffers.length > 0 ? agentOffers[agentOffers.length - 1] : null;

    return {
      dealStatus,
      salesOutcome,
      customerCommitted,
      initialAskingPrice,
      customerOffer: lastCustomerOffer,
      agentCounterOffer: lastAgentOffer,
      finalAgreedPrice,
      agreedDealValue,
      realizedRevenue,
      currency: 'USD',
      isPriceVerified,
      isMissedOpportunity,
      missedOpportunityReason,
      products: finalProducts,
      evidenceExcerpts,
      reviewFlags,
    };
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
    const fullText = transcripts.map((t) => `${(t.speaker || '').toUpperCase()}: ${t.englishText || t.text}`).join('\n');
    const negotiation = this.analyzeDealNegotiation(transcripts);
    const productsDiscussed = negotiation.products.length > 0 ? negotiation.products.map(p => p.name) : this.extractProductsDiscussed(fullText);
    const budgetAndPrice = negotiation.finalAgreedPrice ? `$${negotiation.finalAgreedPrice}` : this.extractBudgetAndPrices(fullText);
    const customerRequirements = this.extractCustomerRequirements(transcripts);
    const { questions, objections } = this.extractQuestionsAndObjections(transcripts);
    const salespersonResponse = this.extractSalespersonResponse(transcripts, objections);

    const conversationOutcome = negotiation.salesOutcome === 'Won'
      ? 'Sale Confirmed'
      : negotiation.salesOutcome === 'Lost'
      ? 'Not Converted'
      : negotiation.salesOutcome === 'Pending'
      ? 'Follow-up Required'
      : 'Unclear';

    const customerBuyingIntent = negotiation.salesOutcome === 'Won'
      ? 'High'
      : (negotiation.salesOutcome === 'Lost' ? 'Low' : this.classifyBuyingIntent(fullText, 0, objections.length));

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
      `Outcome concluded as "${conversationOutcome}" with ${customerBuyingIntent} buying intent.` +
      (negotiation.dealStatus === 'accepted' && negotiation.finalAgreedPrice ? ` Agreed deal value: $${negotiation.finalAgreedPrice}.` : '');

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
      ...negotiation,
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
Store: ${metadata.storeName || metadata.storeCode || 'Star Store'}
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

      // 2. Perform authoritative retail negotiation analysis
      const negotiation = this.analyzeDealNegotiation(usableLines);

      // 3. Fall back to deterministic retail analysis engine if Gemini was not run
      if (!analysisResult) {
        analysisResult = this.analyzeDeterministic(usableLines, metadata);
      }

      const salesOutcome = negotiation.salesOutcome || 'Inconclusive';
      const outcome = salesOutcome === 'Won'
        ? 'Sale Confirmed'
        : salesOutcome === 'Lost'
        ? 'Not Converted'
        : salesOutcome === 'Pending'
        ? 'Follow-up Required'
        : 'Unclear';

      const outcomeExplanation =
        salesOutcome === 'Won'
          ? (negotiation.isPriceVerified
              ? `Customer confirmed purchase at agreed price of $${negotiation.finalAgreedPrice}.`
              : 'Customer confirmed purchase transaction, but final price was unverified in transcript.')
          : salesOutcome === 'Lost'
          ? (negotiation.missedOpportunityReason === 'price_disagreement'
              ? 'Customer rejected purchase due to price disagreement or counteroffer impasse.'
              : 'Customer walked away or rejected offer without purchasing.')
          : salesOutcome === 'Pending'
          ? 'Customer expressed purchase interest but requested time to consider or consult before committing.'
          : 'Dialogue ended without explicit transaction or closure statement.';

      // Format final subdocument
      const finalAnalysis = {
        customerRequirements: analysisResult.customerRequirements || 'Not mentioned',
        productsDiscussed: negotiation.products.length > 0
          ? negotiation.products.map((p) => p.name)
          : (Array.isArray(analysisResult.productsDiscussed) ? analysisResult.productsDiscussed : []),
        budgetAndPrice: negotiation.finalAgreedPrice
          ? `$${negotiation.finalAgreedPrice}`
          : (analysisResult.budgetAndPrice || 'Not mentioned'),
        customerQuestions: Array.isArray(analysisResult.customerQuestions) ? analysisResult.customerQuestions : [],
        customerObjections: Array.isArray(analysisResult.customerObjections) ? analysisResult.customerObjections : [],
        customerBuyingIntent: salesOutcome === 'Won'
          ? 'High'
          : (salesOutcome === 'Lost' ? 'Low' : (analysisResult.customerBuyingIntent || 'Unclear')),
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
        // Deal negotiation attributes
        dealStatus: negotiation.dealStatus,
        customerCommitted: negotiation.customerCommitted,
        initialAskingPrice: negotiation.initialAskingPrice,
        customerOffer: negotiation.customerOffer,
        agentCounterOffer: negotiation.agentCounterOffer,
        finalAgreedPrice: negotiation.finalAgreedPrice,
        agreedDealValue: negotiation.agreedDealValue,
        realizedRevenue: negotiation.realizedRevenue,
        currency: negotiation.currency || 'USD',
        isPriceVerified: negotiation.isPriceVerified,
        isMissedOpportunity: negotiation.isMissedOpportunity,
        missedOpportunityReason: negotiation.missedOpportunityReason,
        products: negotiation.products || [],
        evidenceExcerpts: negotiation.evidenceExcerpts || [],
        reviewFlags: negotiation.reviewFlags || [],
      };

      // Synchronize verified revenue and sales flags
      session.dealAnalysis = finalAnalysis;
      if (negotiation.dealStatus === 'accepted' && negotiation.isPriceVerified && typeof negotiation.agreedDealValue === 'number') {
        session.verifiedRevenue = negotiation.agreedDealValue;
        session.verifiedSale = true;
      } else if (negotiation.dealStatus === 'lost' || negotiation.dealStatus === 'pending') {
        session.verifiedRevenue = 0;
        session.verifiedSale = false;
      }

      // Also sync legacy analytics fields for compatibility
      if (session.analytics) {
        session.analytics.dealOutcome =
          salesOutcome === 'Won'
            ? 'won'
            : salesOutcome === 'Lost'
            ? 'lost'
            : salesOutcome === 'Pending'
            ? 'in_negotiation'
            : 'inquiry_only';
        session.analytics.summary = finalAnalysis.summary;
        session.analytics.devicesDiscussed = finalAnalysis.productsDiscussed;
      }

      await session.save();
      console.log(`✅ [Deal Analysis] Analysis generated & persisted for session: ${sessionId} (${finalAnalysis.conversationOutcome}, agreedValue: $${finalAnalysis.agreedDealValue})`);

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
