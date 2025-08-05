// backend/utils/emailParser.js - Enhanced email parsing with subscription tracking, cancellation detection, and monthly charge analysis

// Helper function to extract service name intelligently
const extractServiceName = (from, text, trustedServices, subject = '') => {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();
  let serviceName = '';
  
  // Priority 1: Check for specific service mentions in subject/body
  const specificServices = {
    'puregym': ['puregym', 'pure gym'],
    'namecheap': ['namecheap', 'cdn'],
    'anthropic': ['anthropic', 'claude'],
    'paddle': ['paddle', 'leonardo interactive'],
    'emirates nbd': ['emirates nbd', 'emiratesnbd'],
    'webflow': ['webflow'],
    'github': ['github'],
    'fal': ['fal', 'team fal', 'fal.ai'],
    'leonardo': ['leonardo interactive', 'leonardo ai'],
  };
  
  for (const [service, keywords] of Object.entries(specificServices)) {
    if (keywords.some(keyword => fromLower.includes(keyword) || subjectLower.includes(keyword) || text.includes(keyword))) {
      serviceName = service;
      break;
    }
  }
  
  // Priority 2: Check trusted services list
  if (!serviceName) {
    const detectedService = trustedServices.find(service => 
      fromLower.includes(service) || text.includes(service)
    );
    if (detectedService) {
      serviceName = detectedService;
    }
  }
  
  // Priority 3: Extract from sender name (before email)
  if (!serviceName) {
    const nameMatch = from.match(/^([^<]+)</);
    if (nameMatch && nameMatch[1].trim()) {
      const senderName = nameMatch[1].trim();
      // Use sender name if it's not generic
      if (!senderName.toLowerCase().includes('noreply') && 
          !senderName.toLowerCase().includes('support') &&
          !senderName.toLowerCase().includes('billing') &&
          !senderName.toLowerCase().includes('team')) {
        serviceName = senderName;
      }
    }
  }
  
  // Priority 4: Extract from sender domain
  if (!serviceName) {
    const emailMatch = from.match(/@([^.]+)/);
    if (emailMatch) {
      serviceName = emailMatch[1];
    }
  }
  
  // Clean up service name
  serviceName = serviceName
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  if (!serviceName) {
    serviceName = 'Unknown Service';
  }
  
  return serviceName;
};

const parseEmailForSubscription = (messageData) => {
  try {
    const headers = messageData.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const from = headers.find(h => h.name === 'From')?.value || '';
    const dateHeader = headers.find(h => h.name === 'Date')?.value || '';
    
    // Enhanced email body extraction - get both plain text and HTML
    let body = '';
    let htmlBody = '';
    
    const extractBodyRecursively = (part) => {
      if (part.body && part.body.data) {
        const content = Buffer.from(part.body.data, 'base64').toString('utf-8');
        if (part.mimeType === 'text/plain') {
          body += content + ' ';
        } else if (part.mimeType === 'text/html') {
          htmlBody += content + ' ';
        }
      }
      
      if (part.parts) {
        part.parts.forEach(extractBodyRecursively);
      }
    };
    
    if (messageData.payload.body && messageData.payload.body.data) {
      body = Buffer.from(messageData.payload.body.data, 'base64').toString('utf-8');
    } else if (messageData.payload.parts) {
      messageData.payload.parts.forEach(extractBodyRecursively);
    }
    
    // If we have HTML but no plain text, extract text from HTML
    if (!body && htmlBody) {
      // Simple HTML tag removal
      body = htmlBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    }
    
    // Combine both for analysis
    const fullContent = body + ' ' + htmlBody;
    const text = (subject + ' ' + fullContent).toLowerCase();
    const fromLower = from.toLowerCase();
    
    // PROMOTIONAL EMAIL FILTERS - Strong indicators this is NOT a paid subscription
    const promotionalIndicators = [
      // Sales and marketing language
      'sale', 'discount', 'offer', 'deal', 'promo', 'special', 'limited time',
      'save', 'off', 'free trial', 'try free', 'start your free', 'get started',
      'sign up', 'subscribe now', 'join today', 'upgrade now', 'unlock',
      
      // CTA language
      'click here', 'learn more', 'find out', 'discover', 'explore',
      'dont miss', "don't miss", 'hurry', 'act now', 'expires',
      
      // Marketing terms
      'newsletter', 'updates', 'announcement', 'introducing', 'new feature',
      'coming soon', 'beta', 'early access', 'invitation', 'invite',
      
      // Unsubscribe indicators (promotional emails usually have these)
      'unsubscribe', 'opt out', 'manage preferences', 'email preferences'
    ];

    // PAID SUBSCRIPTION INDICATORS - Strong indicators this IS a paid subscription
    const paidSubscriptionIndicators = [
      // Payment confirmations
      'payment successful', 'payment confirmed', 'payment received',
      'charged', 'billed', 'invoice', 'receipt', 'billing',
      'payment processed', 'transaction complete', 'payment method charged',
      'payment confirmation', 'membership invoice',
      
      // Receipt patterns
      'receipt', 'your receipt', 'payment receipt', 'billing receipt',
      'invoice receipt', 'transaction receipt',
      
      // Renewal language
      'renewal', 'renewed', 'subscription renewed', 'auto-renewal',
      'next billing', 'upcoming payment', 'payment due', 'recurring payment',
      'subscription continues', 'plan continues', 'auto-renew',
      'will be renewed', 'subscription to', 'membership expires',
      
      // Transaction details
      'transaction', 'purchase', 'order confirmation', 'payment confirmation',
      'subscription active', 'plan activated', 'service continues',
      'monthly billing', 'annual billing', 'subscription payment',
      
      // Amount/pricing language with specific context
      'your plan', 'your subscription', 'monthly charge', 'annual fee',
      'subscription fee', 'membership fee', 'recurring charge',
      'subscription cost', 'billing amount', 'payment amount'
    ];

    // CANCELLATION INDICATORS - Strong indicators this is a cancellation email
    const cancellationIndicators = [
      'subscription cancelled', 'subscription canceled', 'plan cancelled',
      'plan canceled', 'membership cancelled', 'membership canceled',
      'service cancelled', 'service canceled', 'account closed',
      'subscription ended', 'plan ended', 'service ended',
      'cancelled your subscription', 'canceled your subscription',
      'subscription will end', 'plan will end', 'service will end',
      'final payment', 'last billing', 'final invoice',
      'no longer be charged', 'billing has stopped', 'payments have stopped',
      'auto-renewal disabled', 'auto-renew disabled', 'recurring billing stopped',
      'subscription termination', 'account deactivated', 'service discontinued'
    ];

    // MONTHLY CHARGE INDICATORS - Specific patterns for monthly billing
    const monthlyChargeIndicators = [
      'monthly subscription', 'monthly plan', 'monthly billing',
      'monthly charge', 'monthly payment', 'monthly fee',
      'billed monthly', 'charged monthly', 'recurring monthly',
      'per month', '/month', 'every month', 'monthly recurring',
      'monthly membership', 'monthly service'
    ];

    // TRUSTED SUBSCRIPTION SERVICES - Known legitimate subscription services
    const trustedServices = [
      'netflix', 'spotify', 'apple', 'google', 'microsoft', 'adobe',
      'amazon', 'dropbox', 'github', 'slack', 'zoom', 'notion',
      'discord', 'youtube', 'hulu', 'disney', 'prime video',
      'office 365', 'gmail', 'icloud', 'onedrive', 'canva',
      'figma', 'trello', 'asana', 'monday', 'salesforce',
      'twitch', 'patreon', 'mailchimp', 'stripe', 'paypal',
      'namecheap', 'paddle', 'puregym', 'leonardo', 'fal',
      'webflow', 'vercel', 'netlify', 'planetscale', 'railway'
    ];

    // EXCLUDE SENDERS - These are likely promotional or non-subscription
    const excludeSenders = [
      'marketing', 'promo', 'deals', 'offers', 'newsletter',
      'updates', 'news', 'info', 'hello', 'hi', 'team',
      'support' // Only when combined with promotional indicators
    ];

    // SCORING SYSTEM - Calculate likelihood this is a paid subscription, cancellation, or monthly charge
    let subscriptionScore = 0;
    let promotionalScore = 0;
    let cancellationScore = 0;
    let monthlyChargeScore = 0;

    // Check for promotional indicators
    promotionalIndicators.forEach(indicator => {
      if (text.includes(indicator)) {
        promotionalScore += 1;
      }
    });

    // Check for paid subscription indicators
    paidSubscriptionIndicators.forEach(indicator => {
      if (text.includes(indicator)) {
        subscriptionScore += 2; // Weight these more heavily
      }
    });

    // Check for cancellation indicators
    cancellationIndicators.forEach(indicator => {
      if (text.includes(indicator)) {
        cancellationScore += 3; // High weight for cancellation
      }
    });

    // Check for monthly charge indicators
    monthlyChargeIndicators.forEach(indicator => {
      if (text.includes(indicator)) {
        monthlyChargeScore += 2;
      }
    });

    // Check for trusted services (medium weight)
    trustedServices.forEach(service => {
      if (fromLower.includes(service) || text.includes(service)) {
        subscriptionScore += 1;
      }
    });

    // Check for exclude senders
    excludeSenders.forEach(sender => {
      if (fromLower.includes(sender)) {
        promotionalScore += 1;
      }
    });

    // Special checks for amount patterns - paid subscriptions usually have specific amounts
    const hasSpecificAmount = /\$\d+\.\d{2}/.test(text) || /\d+\.\d{2}\s*(usd|eur|gbp)/.test(text);
    if (hasSpecificAmount) {
      subscriptionScore += 2;
    }

    // Check for subscription management language (paid subscriptions have these)
    const subscriptionManagementTerms = ['manage subscription', 'cancel subscription', 'billing details', 'payment method'];
    if (subscriptionManagementTerms.some(term => text.includes(term))) {
      subscriptionScore += 2;
    }

    // Strong promotional language gets heavy penalty
    const strongPromotionalTerms = ['free trial', 'try free', 'sign up now', 'get started free', 'upgrade now'];
    if (strongPromotionalTerms.some(term => text.includes(term))) {
      promotionalScore += 3;
    }

    // PAYMENT HISTORY ANALYSIS - Check for patterns indicating recurring payments
    const paymentHistoryPatterns = [
      /(?:previous|last|prior)\s+(?:payment|charge|billing)\s*:?\s*\$?(\d+(?:\.\d{2})?)/gi,
      /(?:charged|billed)\s+(?:last|previous)\s+month\s*:?\s*\$?(\d+(?:\.\d{2})?)/gi,
      /(?:recurring|monthly)\s+(?:charge|payment)\s*:?\s*\$?(\d+(?:\.\d{2})?)/gi,
      /(?:payment\s+history|billing\s+history|transaction\s+history)/gi
    ];

    let hasPaymentHistory = false;
    paymentHistoryPatterns.forEach(pattern => {
      if (pattern.test(text)) {
        hasPaymentHistory = true;
        subscriptionScore += 2;
      }
    });

    // DATE CONSISTENCY ANALYSIS - Check for renewal date patterns
    const renewalDatePatterns = [
      /(?:renews?|bills?|charges?)\s+(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(?:each|every)\s+month/gi,
      /(?:monthly|recurring)\s+(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?/gi,
      /(?:next|upcoming)\s+(?:payment|charge|billing)\s*:?\s*([a-zA-Z]+\s+\d{1,2},?\s+\d{4})/gi
    ];

    let hasConsistentRenewalDate = false;
    renewalDatePatterns.forEach(pattern => {
      if (pattern.test(text)) {
        hasConsistentRenewalDate = true;
        subscriptionScore += 2;
      }
    });

    // Define service and keyword detection variables early for logging
    const isKnownSubscriptionService = trustedServices.some(service => 
      fromLower.includes(service) || text.includes(service)
    );
    
    const hasSubscriptionKeywords = (
      text.includes('subscription') || 
      text.includes('membership') || 
      text.includes('plan') ||
      text.includes('billing') ||
      text.includes('invoice')
    );

    // Final decision logic
    console.log(`Email scoring - Subscription: ${subscriptionScore}, Promotional: ${promotionalScore}, Cancellation: ${cancellationScore}, Monthly: ${monthlyChargeScore}`);
    console.log(`Subject: ${subject}`);
    console.log(`From: ${from}`);
    console.log(`Payment History: ${hasPaymentHistory}, Consistent Renewal: ${hasConsistentRenewalDate}`);
    console.log(`Known Service: ${isKnownSubscriptionService}, Has Keywords: ${hasSubscriptionKeywords}`);
    console.log(`Membership Invoice: ${text.includes('membership') && text.includes('invoice')}`);

    // Handle cancellation emails
    if (cancellationScore >= 3) {
      console.log('✅ Detected cancellation email');
      return {
        type: 'cancellation',
        serviceName: extractServiceName(from, text, trustedServices, subject),
        subject,
        from,
        date: new Date(dateHeader),
        cancellationScore
      };
    }

    // More aggressive subscription detection logic
    const isLikelySubscription = (
      subscriptionScore >= 2 && // Much lower threshold
      (promotionalScore <= subscriptionScore || subscriptionScore >= 5) && // More flexible promotional check
      (monthlyChargeScore >= 1 || hasPaymentHistory || hasConsistentRenewalDate || 
       subscriptionScore >= 4 || // Lower threshold for high confidence
       (isKnownSubscriptionService && hasSubscriptionKeywords) || // Or known service with subscription keywords
       (text.includes('membership') && text.includes('invoice')) || // Special case for membership invoices
       (text.includes('subscription') && text.includes('renewed')) || // Special case for renewal notifications
       (text.includes('receipt') && isKnownSubscriptionService) || // Receipt from known service
       (text.includes('payment confirmation') && isKnownSubscriptionService) || // Payment confirmation from known service
       (isKnownSubscriptionService && subscriptionScore >= 2) || // Any known service with score >= 2
       (text.includes('billed') || text.includes('charged')) && subscriptionScore >= 3) // Billing language
    );

    if (!isLikelySubscription) {
      console.log('Rejected: Not a likely subscription email');
      return null;
    }

    const serviceName = extractServiceName(from, text, trustedServices, subject);

    // Enhanced amount extraction with multiple patterns - more specific for paid subscriptions
    const amountPatterns = [
      // Specific billing contexts
      /(?:charged|billed|paid)\s*\$(\d+(?:\.\d{2})?)/gi,
      /(?:amount|total|charge|bill|payment)[:\s]*\$(\d+(?:\.\d{2})?)/gi,
      /\$(\d+(?:\.\d{2})?)(?:\s*(?:per month|monthly|\/month))?/gi,
      /(\d+(?:\.\d{2})?)\s*(?:USD|EUR|GBP|\$)/gi,
      // Subscription-specific patterns
      /(?:subscription|plan|membership)\s*(?:fee|cost|price)[:\s]*\$?(\d+(?:\.\d{2})?)/gi,
      // More flexible patterns for various formats
      /(?:price|cost|fee)[:\s]*(\d+(?:\.\d{2})?)/gi,
      /(?:renew|renewal)[:\s]*\$?(\d+(?:\.\d{2})?)/gi,
      // Pattern for amounts in different contexts
      /(?:^|\s)(\d{1,3}(?:\.\d{2})?)\s*(?:usd|dollars?|per\s+month|monthly)/gi
    ];
    
    let amount = null; // Don't default - require actual amount detection
    let currency = 'USD';
    
    for (const pattern of amountPatterns) {
      const matches = [...text.matchAll(pattern)];
      if (matches.length > 0) {
        const match = matches[0];
        const numberStr = match[1] || match[0].replace(/[^\d.]/g, '');
        const parsedAmount = parseFloat(numberStr);
        
        // More restrictive amount validation for subscriptions
        if (parsedAmount > 0.99 && parsedAmount < 500) { // Reasonable subscription amount range
          amount = parsedAmount;
          
          // Detect currency
          if (match[0].includes('EUR') || match[0].includes('€')) currency = 'EUR';
          else if (match[0].includes('GBP') || match[0].includes('£')) currency = 'GBP';
          
          break;
        }
      }
    }

    // Special handling for known subscription services even without explicit amounts
    
    // For known services with subscription keywords, try to extract or estimate amount
    if (!amount && isKnownSubscriptionService && hasSubscriptionKeywords) {
      // Try to find any number that could be an amount in the full content
      const numberMatches = fullContent.match(/(\d{1,3}(?:\.\d{2})?)/g);
      if (numberMatches) {
        for (const numStr of numberMatches) {
          const num = parseFloat(numStr);
          if (num >= 1 && num <= 500) {
            amount = num;
            console.log(`Estimated amount for ${serviceName}: $${amount}`);
            break;
          }
        }
      }
      
      // If still no amount for membership invoices, set a placeholder
      if (!amount && text.includes('membership') && text.includes('invoice')) {
        amount = 50; // Default gym membership amount
        console.log(`Default amount set for ${serviceName} membership: $${amount}`);
      }
    }
    
    // Additional validation - require amount for high confidence, unless it's a free tier notification
    if (!amount && !text.includes('free')) {
      console.log('Rejected: No valid subscription amount found');
      return null;
    }
    
    // Handle free tier subscriptions that might renew to paid
    if (!amount && text.includes('free')) {
      amount = 0; // Mark as free tier
      currency = 'USD';
    }

    // Enhanced renewal date calculation with better date parsing
    const calculateNextRenewal = () => {
      const now = new Date();
      let nextRenewal = new Date();
      
      // Try to extract renewal date from email content
      const datePatterns = [
        /(?:next\s+(?:billing|payment|renewal))[:\s]*([a-zA-Z]+\s+\d{1,2},?\s+\d{4})/gi,
        /(?:due\s+(?:date|on))[:\s]*([a-zA-Z]+\s+\d{1,2},?\s+\d{4})/gi,
        /(?:renews?\s+(?:on)?)[:\s]*([a-zA-Z]+\s+\d{1,2},?\s+\d{4})/gi,
        /(\d{1,2}\/\d{1,2}\/\d{4})/g, // MM/DD/YYYY
        /(\d{4}-\d{1,2}-\d{1,2})/g   // YYYY-MM-DD
      ];
      
      for (const pattern of datePatterns) {
        const matches = [...text.matchAll(pattern)];
        if (matches.length > 0) {
          const dateStr = matches[0][1];
          const parsedDate = new Date(dateStr);
          if (parsedDate > now) {
            nextRenewal = parsedDate;
            break;
          }
        }
      }
      
      // If no specific date found, default to next month
      if (nextRenewal <= now) {
        nextRenewal = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
      }
      
      return nextRenewal;
    };

    const nextRenewal = calculateNextRenewal();
    const renewalDay = nextRenewal.getDate();

    // Enhanced categorization based on service name
    let category = 'Other';
    const serviceNameLower = serviceName.toLowerCase();
    
    if (['netflix', 'spotify', 'hulu', 'disney', 'youtube', 'amazon prime', 'prime video', 'twitch'].some(s => serviceNameLower.includes(s))) {
      category = 'Entertainment & Media';
    } else if (['adobe', 'figma', 'canva', 'office', 'microsoft', 'notion', 'trello', 'asana'].some(s => serviceNameLower.includes(s))) {
      category = 'Software & Productivity';
    } else if (['github', 'aws', 'digital ocean', 'heroku', 'google cloud', 'azure', 'anthropic', 'openai'].some(s => serviceNameLower.includes(s))) {
      category = 'Software & Productivity';
    } else if (['gym', 'fitness', 'yoga', 'peloton', 'puregym', 'membership'].some(s => serviceNameLower.includes(s)) || text.includes('membership')) {
      category = 'Health & Fitness';
    } else if (['namecheap', 'domain', 'hosting', 'cdn'].some(s => serviceNameLower.includes(s))) {
      category = 'Web Services & Hosting';
    }

    // Final validation - ensure this looks like a legitimate subscription
    const finalValidation = () => {
      // Must have a reasonable service name
      if (serviceName.length < 2) return false;
      
      // Must have reasonable amount (allow $0 for free tiers)
      if (amount < 0 || amount > 500) return false;
      
      // More flexible scoring for known services
      if (isKnownSubscriptionService && hasSubscriptionKeywords) {
        return subscriptionScore >= 2; // Lower threshold for known services
      }
      
      // Special case for membership invoices (like PureGym)
      if (text.includes('membership') && text.includes('invoice') && subscriptionScore >= 3) {
        return true;
      }
      
      // Special case for renewal notifications
      if (text.includes('subscription') && text.includes('renewed') && subscriptionScore >= 3) {
        return true;
      }
      
      // Must have scored high enough on subscription indicators for unknown services
      if (subscriptionScore < 4) return false;
      
      return true;
    };

    if (!finalValidation()) {
      console.log('Rejected: Failed final validation checks');
      return null;
    }

    // Calculate payment recency for filtering
    const paymentDate = new Date(dateHeader);
    const daysSincePayment = Math.floor((new Date() - paymentDate) / (1000 * 60 * 60 * 24));
    
    const subscription = {
      type: 'subscription',
      serviceName: serviceName.charAt(0).toUpperCase() + serviceName.slice(1),
      amount,
      currency,
      renewalDay,
      nextRenewal,
      category,
      description: `Auto-detected from email: ${subject.substring(0, 50)}${subject.length > 50 ? '...' : ''}`,
      confidence: subscriptionScore,
      hasPaymentHistory,
      hasConsistentRenewalDate,
      isMonthlyCharge: monthlyChargeScore >= 2,
      subject,
      from,
      date: paymentDate,
      daysSincePayment,
      isRecentPayment: daysSincePayment <= 30
    };

    console.log('✅ Accepted subscription:', {
      serviceName: subscription.serviceName,
      amount: subscription.amount,
      currency: subscription.currency,
      nextRenewal: subscription.nextRenewal,
      category: subscription.category,
      confidence: subscription.confidence,
      isMonthlyCharge: subscription.isMonthlyCharge
    });

    return subscription;
  } catch (error) {
    console.error('Error parsing email:', error);
    return null;
  }
};

// Enhanced function to detect subscription patterns with monthly occurrence analysis
const analyzeSubscriptionPatterns = (emails) => {
  const servicePayments = new Map();
  const cancellations = new Map();
  
  emails.forEach(email => {
    const parsed = parseEmailForSubscription(email);
    if (!parsed) return;
    
    if (parsed.type === 'cancellation') {
      cancellations.set(parsed.serviceName.toLowerCase(), parsed);
    } else if (parsed.type === 'subscription') {
      const serviceKey = parsed.serviceName.toLowerCase();
      if (!servicePayments.has(serviceKey)) {
        servicePayments.set(serviceKey, []);
      }
      servicePayments.get(serviceKey).push(parsed);
    }
  });
  
  // Enhanced payment pattern analysis
  const confirmedSubscriptions = [];
  
  servicePayments.forEach((payments, serviceKey) => {
    // Check if service was cancelled
    if (cancellations.has(serviceKey)) {
      console.log(`${serviceKey} was cancelled, skipping...`);
      return;
    }
    
    // Sort payments by date (newest first)
    payments.sort((a, b) => new Date(b.date) - new Date(a.date));
    const latestPayment = payments[0];
    const daysSinceLatest = Math.floor((new Date() - new Date(latestPayment.date)) / (1000 * 60 * 60 * 24));
    
    // Filter out very old subscriptions (older than 6 months)
    if (daysSinceLatest > 180) {
      console.log(`${serviceKey}: Latest payment too old (${daysSinceLatest} days), skipping...`);
      return;
    }
    
    if (payments.length === 1) {
      // Single payment analysis with enhanced recency checks
      const payment = payments[0];
      const isVeryRecent = daysSinceLatest <= 30; // Within 30 days
      const isRecentlyActive = daysSinceLatest <= 90; // Within 3 months
      
      // More stringent criteria for single payments
      const shouldAccept = (
        (isVeryRecent && payment.confidence >= 3) || // Recent payment with decent confidence
        (payment.confidence >= 6) || // High confidence regardless of age
        (payment.hasPaymentHistory && isRecentlyActive) || // Has payment history and recent
        (payment.hasConsistentRenewalDate && isRecentlyActive) || // Consistent renewal pattern
        (payment.isMonthlyCharge && isRecentlyActive) // Clear monthly charge language
      );
      
      if (shouldAccept) {
        confirmedSubscriptions.push({
          ...payment,
          confidence: payment.confidence >= 6 ? 'high' : (isVeryRecent ? 'medium' : 'low'),
          confidenceScore: payment.confidence,
          paymentCount: 1,
          isRecentPayment: isVeryRecent,
          daysSinceLastPayment: daysSinceLatest,
          isRecurring: isVeryRecent || payment.confidence >= 6
        });
      } else {
        console.log(`${serviceKey}: Single payment rejected - Age: ${daysSinceLatest} days, Confidence: ${payment.confidence}`);
      }
    } else {
      // Multiple payments - enhanced recurring pattern analysis
      const amounts = payments.map(p => p.amount);
      const dates = payments.map(p => new Date(p.date));
      
      // Check amount consistency
      const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      const consistentAmount = amounts.every(amount => Math.abs(amount - avgAmount) <= (avgAmount * 0.1)); // 10% tolerance
      
      // Check temporal patterns for monthly billing
      let hasMonthlyPattern = false;
      if (payments.length >= 2) {
        const intervals = [];
        for (let i = 1; i < dates.length; i++) {
          const intervalDays = Math.abs((dates[i-1] - dates[i]) / (1000 * 60 * 60 * 24));
          intervals.push(intervalDays);
        }
        
        // Check if intervals are roughly monthly (25-35 days)
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        hasMonthlyPattern = avgInterval >= 25 && avgInterval <= 35;
        
        console.log(`${serviceKey}: Multiple payments analysis - Avg interval: ${avgInterval.toFixed(1)} days, Monthly pattern: ${hasMonthlyPattern}`);
      }
      
      // Accept if amount is consistent OR has monthly pattern
      if (consistentAmount || hasMonthlyPattern) {
        confirmedSubscriptions.push({
          ...latestPayment,
          confidence: 'very-high',
          confidenceScore: Math.max(latestPayment.confidence, 8), // Boost confidence for recurring
          paymentCount: payments.length,
          isRecurring: true,
          hasMonthlyPattern,
          consistentAmount,
          daysSinceLastPayment: daysSinceLatest,
          isRecentPayment: daysSinceLatest <= 30
        });
      } else {
        console.log(`${serviceKey}: Multiple payments rejected - Inconsistent amounts or no monthly pattern`);
      }
    }
  });
  
  return {
    confirmedSubscriptions,
    cancellations: Array.from(cancellations.values())
  };
};

module.exports = { 
  parseEmailForSubscription,
  analyzeSubscriptionPatterns
};