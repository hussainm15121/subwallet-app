// backend/utils/aiEmailAnalyzer.js - Enhanced OpenAI-powered email analysis for subscription detection

const OpenAI = require('openai');

class AIEmailAnalyzer {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    if (!process.env.OPENAI_API_KEY) {
      console.warn('Warning: OPENAI_API_KEY not found in environment variables');
    }
  }

  // Optimized system prompt for better subscription detection
  getSystemPrompt() {
    return `You are a specialized subscription detection AI. Your sole purpose is to identify legitimate subscription payments and billing emails with high accuracy.

CORE MISSION: Detect ACTUAL subscription payments, not promotional content.

SUBSCRIPTION DETECTION RULES:
✅ ALWAYS MARK AS SUBSCRIPTION:
- Payment confirmations: "Charged $X", "Payment of AED X", "Successfully paid"
- Invoices/bills: "Invoice #123", "Monthly bill", "Statement"  
- Receipts: "Receipt from", "Your receipt", "Payment receipt"
- Membership fees: "Membership fee", "Monthly membership"
- Service renewals: "Plan renewed", "Subscription renewed"
- Auto-billing: "Auto-payment", "Recurring charge"
- Account top-ups: "topped up", "balance increased", "credits added"
- Service confirmations from known providers (Stripe, PayPal, Netflix, Adobe, etc.)

❌ NEVER MARK AS SUBSCRIPTION:
- Marketing/promo: "50% off", "Free trial", "Special offer", "Get started"
- Notifications: "Password reset", "Security alert", "Verify email"
- Updates: "Newsletter", "Product update", "New features"
- Generic banking: Credit card notifications without service context

AMOUNT EXTRACTION (PRIORITY ORDER):
1. Direct amounts: "$20.00", "AED 150", "£9.99"
2. Payment text: "charged $X", "paid AED X" 
3. Invoice totals: "Total: $X", "Amount: $X"
4. If no amount found but confirmed subscription → estimate typical amounts:
   - Gym/fitness: 150 AED/month
   - Basic software: 10 USD/month
   - Premium software: 30 USD/month
   - Hosting/domains: 5 USD/month
   - AI services: 20 USD/month

{
  "isSubscription": boolean,
  "serviceName": string | null,
  "amount": number | null,
  "currency": "USD" | "EUR" | "GBP" | "AED" | null,
  "confidence": number (1-10),
  "description": string | null
}

EXAMPLES:
✅ Anthropic receipt: "Receipt from Anthropic, PBC #2068 $20.00 Paid August 3, 2025" → {"isSubscription": true, "serviceName": "Anthropic Claude", "amount": 20.00, "currency": "USD", "confidence": 9}
✅ Gym invoice: "PureGym membership invoice. See attached." → {"isSubscription": true, "serviceName": "PureGym", "amount": 150, "currency": "AED", "confidence": 8}
✅ Service top-up: "You topped up fal.ai balance by $10.00" → {"isSubscription": true, "serviceName": "fal.ai", "amount": 10.00, "currency": "USD", "confidence": 9}
❌ Bank notification: "Credit card payment CIF: ***45*** AED 1,500.00" → {"isSubscription": false, "serviceName": null, "amount": null, "currency": null, "confidence": 10}

ANALYSIS FOCUS:
- Extract exact amounts when visible
- Identify service name from sender/subject
- Be decisive: subscription billing emails are usually clear
- Estimate amounts only for confirmed subscription services without visible amounts`;
  }

  // Enhanced email content extraction
  extractEmailContent(emailData) {
    const headers = emailData.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const from = headers.find(h => h.name === 'From')?.value || '';
    const date = headers.find(h => h.name === 'Date')?.value || '';
    
    let textBody = '';
    let htmlBody = '';
    
    // Recursive function to extract all text content
    const extractBodyRecursively = (part) => {
      if (part.body && part.body.data) {
        try {
          const content = Buffer.from(part.body.data, 'base64').toString('utf-8');
          if (part.mimeType === 'text/plain') {
            textBody += content + '\n';
          } else if (part.mimeType === 'text/html') {
            htmlBody += content + '\n';
          }
        } catch (error) {
          console.warn('Error decoding email part:', error.message);
        }
      }
      
      if (part.parts && Array.isArray(part.parts)) {
        part.parts.forEach(extractBodyRecursively);
      }
    };
    
    // Extract from main body
    if (emailData.payload.body && emailData.payload.body.data) {
      try {
        const mainContent = Buffer.from(emailData.payload.body.data, 'base64').toString('utf-8');
        if (emailData.payload.mimeType === 'text/plain') {
          textBody = mainContent;
        } else if (emailData.payload.mimeType === 'text/html') {
          htmlBody = mainContent;
        }
      } catch (error) {
        console.warn('Error decoding main email body:', error.message);
      }
    }
    
    // Extract from parts
    if (emailData.payload.parts && Array.isArray(emailData.payload.parts)) {
      emailData.payload.parts.forEach(extractBodyRecursively);
    }
    
    // Convert HTML to plain text if no plain text available
    let cleanTextBody = textBody;
    if (!cleanTextBody && htmlBody) {
      cleanTextBody = htmlBody
        .replace(/<style[^>]*>.*?<\/style>/gis, '')
        .replace(/<script[^>]*>.*?<\/script>/gis, '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    }
    
    // Combine all content for comprehensive analysis
    const fullContent = `${textBody}\n${cleanTextBody}`.trim();
    
    return {
      subject,
      from,
      date,
      textBody: cleanTextBody || textBody,
      htmlBody,
      fullContent,
      contentLength: fullContent.length
    };
  }

  // Concise user prompt for faster analysis
  getUserPrompt(extracted) {
    return `ANALYZE FOR SUBSCRIPTION:

Subject: ${extracted.subject}
From: ${extracted.from}
Content: ${extracted.fullContent.substring(0, 1000)}${extracted.fullContent.length > 1000 ? '...' : ''}

IS THIS A SUBSCRIPTION PAYMENT/BILLING EMAIL? Extract service name and amount if yes. Respond with JSON only.`;
  }

  // Analyze a single email with enhanced content extraction
  async analyzeEmail(emailData) {
    try {
      const extracted = this.extractEmailContent(emailData);
      
      console.log(`Analyzing email: "${extracted.subject}" from ${extracted.from} (Content: ${extracted.contentLength} chars)`);
      
      // Debug: Log first 200 chars of content to verify extraction
      console.log(`Content preview: ${extracted.fullContent.substring(0, 200)}${extracted.fullContent.length > 200 ? '...' : ''}`);

      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: this.getSystemPrompt()
          },
          {
            role: "user",
            content: this.getUserPrompt(extracted)
          }
        ],
        temperature: 0.1,
        max_tokens: 300, // Reduced for faster response
        response_format: { type: "json_object" }
      });

      const response = completion.choices[0].message.content;
      const analysis = JSON.parse(response);

      console.log(`AI Analysis Result: ${analysis.isSubscription ? 'SUBSCRIPTION' : 'NOT SUBSCRIPTION'} - ${analysis.serviceName || 'Unknown'} (Amount: ${analysis.amount ? `${analysis.currency || 'USD'} ${analysis.amount}` : 'None'}, Confidence: ${analysis.confidence}/10)`);

      return {
        ...analysis,
        originalEmail: {
          subject: extracted.subject,
          from: extracted.from,
          date: extracted.date
        }
      };

    } catch (error) {
      console.error('Error analyzing email with AI:', error);
      return null;
    }
  }

  // Batch analyze multiple emails with better processing
  async batchAnalyzeEmails(emailsData, batchSize = 3) {
    console.log(`Starting enhanced AI batch analysis of ${emailsData.length} emails (batch size: ${batchSize})`);
    
    const results = {
      subscriptions: [],
      cancellations: [],
      nonSubscriptions: [],
      errors: []
    };

    // Process emails in smaller batches to ensure quality analysis
    for (let i = 0; i < emailsData.length; i += batchSize) {
      const batch = emailsData.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(emailsData.length / batchSize)}`);

      // Process batch sequentially for better API usage
      for (const emailData of batch) {
        try {
          const analysis = await this.analyzeEmail(emailData);
          
          if (!analysis) {
            results.errors.push('Analysis failed');
            continue;
          }

          if (analysis.isSubscription) {
            if (analysis.type === 'cancellation') {
              results.cancellations.push(analysis);
            } else {
              results.subscriptions.push(analysis);
            }
          } else {
            results.nonSubscriptions.push(analysis);
          }
          
          // Small delay between requests
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error('Error in batch analysis:', error);
          results.errors.push('Analysis failed');
        }
      }

      // Longer delay between batches
      if (i + batchSize < emailsData.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    console.log(`Enhanced AI Analysis Complete:`, {
      subscriptions: results.subscriptions.length,
      cancellations: results.cancellations.length,
      nonSubscriptions: results.nonSubscriptions.length,
      errors: results.errors.length
    });

    return results;
  }

  // Enhanced category mapping for consistent categorization
  getCategoryForService(serviceName) {
    if (!serviceName) return 'Other';
    
    const serviceNameLower = serviceName.toLowerCase().trim();
    
    // Service mapping for automatic categorization
    const serviceMapping = {
      // Entertainment & Media
      'netflix': 'Entertainment & Media',
      'disney': 'Entertainment & Media',
      'hulu': 'Entertainment & Media',
      'prime video': 'Entertainment & Media',
      'amazon prime': 'Entertainment & Media',
      'paramount': 'Entertainment & Media',
      'peacock': 'Entertainment & Media',
      'hbo': 'Entertainment & Media',
      'showtime': 'Entertainment & Media',
      'starz': 'Entertainment & Media',
      'crunchyroll': 'Entertainment & Media',
      
      // Music & Audio
      'spotify': 'Music & Audio',
      'apple music': 'Music & Audio',
      'youtube music': 'Music & Audio',
      'pandora': 'Music & Audio',
      'tidal': 'Music & Audio',
      'soundcloud': 'Music & Audio',
      'audible': 'Music & Audio',
      'podcast': 'Music & Audio',
      
      // Software & Productivity
      'microsoft': 'Software & Productivity',
      'office 365': 'Software & Productivity',
      'adobe': 'Software & Productivity',
      'notion': 'Software & Productivity',
      'slack': 'Software & Productivity',
      'zoom': 'Software & Productivity',
      'teams': 'Software & Productivity',
      'asana': 'Software & Productivity',
      'trello': 'Software & Productivity',
      'monday': 'Software & Productivity',
      'clickup': 'Software & Productivity',
      'airtable': 'Software & Productivity',
      'zapier': 'Software & Productivity',
      'calendly': 'Software & Productivity',
      'anthropic': 'Software & Productivity',
      'openai': 'Software & Productivity',
      'github': 'Software & Productivity',
      'gitlab': 'Software & Productivity',
      'fal': 'Software & Productivity',
      
      // Design & Creative
      'canva': 'Design & Creative',
      'figma': 'Design & Creative',
      'sketch': 'Design & Creative',
      'invision': 'Design & Creative',
      'framer': 'Design & Creative',
      'creative cloud': 'Design & Creative',
      'photoshop': 'Design & Creative',
      'illustrator': 'Design & Creative',
      'leonardo': 'Design & Creative',
      'runway': 'Design & Creative',
      'midjourney': 'Design & Creative',
      
      // Web Services & Hosting
      'namecheap': 'Web Services & Hosting',
      'godaddy': 'Web Services & Hosting',
      'bluehost': 'Web Services & Hosting',
      'hostgator': 'Web Services & Hosting',
      'cloudflare': 'Web Services & Hosting',
      'aws': 'Web Services & Hosting',
      'google cloud': 'Web Services & Hosting',
      'azure': 'Web Services & Hosting',
      'digitalocean': 'Web Services & Hosting',
      'linode': 'Web Services & Hosting',
      'heroku': 'Web Services & Hosting',
      'vercel': 'Web Services & Hosting',
      'netlify': 'Web Services & Hosting',
      'webflow': 'Web Services & Hosting',
      'squarespace': 'Web Services & Hosting',
      'wix': 'Web Services & Hosting',
      'wordpress': 'Web Services & Hosting',
      'cdn': 'Web Services & Hosting',
      
      // Health & Fitness
      'puregym': 'Health & Fitness',
      'peloton': 'Health & Fitness',
      'fitbit': 'Health & Fitness',
      'myfitnesspal': 'Health & Fitness',
      'strava': 'Health & Fitness',
      'headspace': 'Health & Fitness',
      'calm': 'Health & Fitness',
      'noom': 'Health & Fitness',
      'gym': 'Health & Fitness',
      'fitness': 'Health & Fitness',
      
      // Gaming
      'steam': 'Gaming',
      'xbox': 'Gaming',
      'playstation': 'Gaming',
      'nintendo': 'Gaming',
      'epic games': 'Gaming',
      'origin': 'Gaming',
      'ubisoft': 'Gaming',
      'blizzard': 'Gaming',
      'twitch': 'Gaming',
      'discord nitro': 'Gaming',
      
      // Education & Learning
      'coursera': 'Education & Learning',
      'udemy': 'Education & Learning',
      'skillshare': 'Education & Learning',
      'masterclass': 'Education & Learning',
      'linkedin learning': 'Education & Learning',
      'pluralsight': 'Education & Learning',
      'codecademy': 'Education & Learning',
      'khan academy': 'Education & Learning',
      'duolingo': 'Education & Learning',
      'babbel': 'Education & Learning',
      'rosetta stone': 'Education & Learning',
      
      // Storage & Cloud
      'dropbox': 'Storage & Cloud',
      'google drive': 'Storage & Cloud',
      'icloud': 'Storage & Cloud',
      'onedrive': 'Storage & Cloud',
      'box': 'Storage & Cloud',
      'mega': 'Storage & Cloud',
      'backblaze': 'Storage & Cloud',
      
      // Security & Privacy
      'nordvpn': 'Security & Privacy',
      'expressvpn': 'Security & Privacy',
      'surfshark': 'Security & Privacy',
      'protonvpn': 'Security & Privacy',
      'lastpass': 'Security & Privacy',
      '1password': 'Security & Privacy',
      'bitwarden': 'Security & Privacy',
      'dashlane': 'Security & Privacy',
      'malwarebytes': 'Security & Privacy',
      'norton': 'Security & Privacy',
      'mcafee': 'Security & Privacy',
      
      // Communication
      'whatsapp': 'Communication',
      'telegram': 'Communication',
      'signal': 'Communication',
      'discord': 'Communication',
      'skype': 'Communication',
      
      // Food & Delivery
      'uber eats': 'Food & Delivery',
      'doordash': 'Food & Delivery',
      'grubhub': 'Food & Delivery',
      'postmates': 'Food & Delivery',
      'deliveroo': 'Food & Delivery',
      'zomato': 'Food & Delivery',
      'talabat': 'Food & Delivery',
      'careem': 'Food & Delivery',
      'hellofresh': 'Food & Delivery',
      'blue apron': 'Food & Delivery',
      
      // Transportation
      'uber': 'Transportation',
      'lyft': 'Transportation',
      'lime': 'Transportation',
      'bird': 'Transportation',
      'zipcar': 'Transportation',
      
      // Finance & Banking
      'mint': 'Finance & Banking',
      'ynab': 'Finance & Banking',
      'quickbooks': 'Finance & Banking',
      'freshbooks': 'Finance & Banking',
      'wave': 'Finance & Banking',
      'stripe': 'Finance & Banking',
      'paypal': 'Finance & Banking',
      'square': 'Finance & Banking',
      
      // News & Magazines
      'new york times': 'News & Magazines',
      'wall street journal': 'News & Magazines',
      'washington post': 'News & Magazines',
      'the guardian': 'News & Magazines',
      'medium': 'News & Magazines',
      'substack': 'News & Magazines',
      'economist': 'News & Magazines',
      'bloomberg': 'News & Magazines',
      
      // Business & Professional
      'salesforce': 'Business & Professional',
      'hubspot': 'Business & Professional',
      'mailchimp': 'Business & Professional',
      'constant contact': 'Business & Professional',
      'surveymoneky': 'Business & Professional',
      'typeform': 'Business & Professional',
      'intercom': 'Business & Professional',
      'zendesk': 'Business & Professional',
      'freshdesk': 'Business & Professional',
      
      // Shopping & Retail
      'costco': 'Shopping & Retail',
      'walmart': 'Shopping & Retail',
      'target': 'Shopping & Retail',
      'instacart': 'Shopping & Retail',
      'shipt': 'Shopping & Retail',
      
      // Travel & Tourism
      'airbnb': 'Travel & Tourism',
      'booking': 'Travel & Tourism',
      'expedia': 'Travel & Tourism',
      'hotels': 'Travel & Tourism',
      'tripadvisor': 'Travel & Tourism',
      'kayak': 'Travel & Tourism'
    };
    
    // Direct mapping lookup
    for (const [service, category] of Object.entries(serviceMapping)) {
      if (serviceNameLower.includes(service.toLowerCase())) {
        return category;
      }
    }
    
    // Keyword-based categorization for services not in mapping
    const keywords = {
      'Entertainment & Media': ['tv', 'movie', 'film', 'entertainment', 'media', 'streaming', 'video'],
      'Music & Audio': ['music', 'audio', 'sound', 'radio', 'podcast', 'song'],
      'Software & Productivity': ['software', 'app', 'tool', 'productivity', 'api', 'ai', 'analytics'],
      'Health & Fitness': ['health', 'fitness', 'gym', 'workout', 'exercise', 'medical', 'wellness'],
      'Gaming': ['game', 'gaming', 'play', 'esports'],
      'Education & Learning': ['education', 'learning', 'course', 'training', 'tutorial', 'study'],
      'Food & Delivery': ['food', 'delivery', 'restaurant', 'meal', 'recipe', 'cooking'],
      'Transportation': ['transport', 'ride', 'taxi', 'car', 'bike', 'scooter'],
      'Finance & Banking': ['bank', 'finance', 'money', 'payment', 'accounting', 'invoice'],
      'Security & Privacy': ['security', 'privacy', 'vpn', 'password', 'antivirus', 'protection'],
      'News & Magazines': ['news', 'magazine', 'journal', 'newspaper', 'article', 'publication'],
      'Web Services & Hosting': ['hosting', 'domain', 'web', 'server', 'cloud', 'infrastructure', 'cdn'],
      'Design & Creative': ['design', 'creative', 'art', 'photo', 'image', 'graphics', 'logo'],
      'Storage & Cloud': ['storage', 'backup', 'sync', 'drive', 'cloud'],
      'Communication': ['chat', 'message', 'call', 'video', 'communication', 'meeting']
    };
    
    for (const [category, categoryKeywords] of Object.entries(keywords)) {
      if (categoryKeywords.some(keyword => serviceNameLower.includes(keyword))) {
        return category;
      }
    }
    
    return 'Other';
  }

  // Convert AI analysis to subscription format for database
  convertToSubscriptionFormat(analysis) {
    if (!analysis.isSubscription || !analysis.serviceName) {
      return null;
    }
    
    // Allow subscriptions without amounts (will be estimated)
    if (!analysis.amount || analysis.amount <= 0) {
      console.log(`Warning: No amount found for ${analysis.serviceName}, will be filtered out in route`);
      return null;
    }

    // Check payment recency to filter out old inactive subscriptions
    const paymentDate = new Date(analysis.originalEmail.date);
    const daysSincePayment = Math.floor((new Date() - paymentDate) / (1000 * 60 * 60 * 24));
    
    // Filter out payments older than 3 months (90 days) unless it's very recent (within 30 days)
    if (daysSincePayment > 90 && daysSincePayment > 30) {
      console.log(`Filtering out old subscription payment for ${analysis.serviceName}: ${daysSincePayment} days old`);
      return null;
    }

    // Use enhanced categorization
    const finalCategory = this.getCategoryForService(analysis.serviceName);
    
    // Use payment date to calculate proper renewal day
    const renewalDay = paymentDate.getDate();
    const nextRenewal = this.calculateNextRenewal(renewalDay);

    const subscription = {
      type: 'subscription',
      serviceName: analysis.serviceName,
      amount: analysis.amount,
      currency: analysis.currency || 'USD',
      renewalDay: renewalDay,
      nextRenewal: nextRenewal,
      category: finalCategory,
      description: analysis.description || `AI-detected: ${analysis.originalEmail.subject.substring(0, 50)}${analysis.originalEmail.subject.length > 50 ? '...' : ''}`,
      confidence: analysis.confidence || 8,
      isMonthlyCharge: true,
      subject: analysis.originalEmail.subject,
      from: analysis.originalEmail.from,
      date: paymentDate,
      hasPaymentHistory: false,
      hasConsistentRenewalDate: false,
      isRecurring: daysSincePayment <= 30, // Only mark as recurring if payment is recent
      paymentCount: 1,
      daysSinceLastPayment: daysSincePayment,
      isRecentPayment: daysSincePayment <= 30
    };

    return subscription;
  }

  // Helper method to calculate next renewal
  calculateNextRenewal(renewalDay) {
    const now = new Date();
    let nextRenewal = new Date(now.getFullYear(), now.getMonth(), renewalDay || now.getDate());
    
    if (nextRenewal <= now) {
      nextRenewal.setMonth(nextRenewal.getMonth() + 1);
    }
    
    return nextRenewal;
  }

  // Check if API key is configured
  isConfigured() {
    return !!process.env.OPENAI_API_KEY;
  }
}

module.exports = { AIEmailAnalyzer };