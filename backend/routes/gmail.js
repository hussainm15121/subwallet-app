// backend/routes/gmail.js - REPLACE COMPLETELY
const express = require('express');
const { google } = require('googleapis');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const auth = require('../middleware/auth');
const { parseEmailForSubscription, analyzeSubscriptionPatterns } = require('../utils/emailParser');
const { AIEmailAnalyzer } = require('../utils/aiEmailAnalyzer');

const router = express.Router();

// Gmail OAuth configuration
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'https://subwallet.up.railway.app/auth/callback'
);

// Get Gmail auth URL
router.get('/auth-url', auth, (req, res) => {
  try {
    console.log('OAuth Config:');
    console.log('- Client ID:', process.env.GOOGLE_CLIENT_ID ? 'Present' : 'Missing');
    console.log('- Client Secret:', process.env.GOOGLE_CLIENT_SECRET ? 'Present' : 'Missing');
    console.log('- Redirect URI:', process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/callback');

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/gmail.readonly'],
      state: req.user._id.toString(),
      prompt: 'consent' // Force consent screen to get refresh token
    });

    console.log('Generated auth URL for user:', req.user._id);
    console.log('Auth URL length:', authUrl.length);
    res.json({ authUrl });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ message: 'Failed to generate auth URL' });
  }
});

// Handle OAuth callback - Legacy single account
router.post('/callback', auth, async (req, res) => {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ message: 'Authorization code is required' });
    }

    console.log('Processing OAuth callback (legacy) for user:', req.user._id);
    console.log('Authorization code received');

    // Create a new OAuth client instance to avoid conflicts
    const legacyOAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || 'https://subwallet.up.railway.app/auth/callback'
    );

    // Exchange code for tokens
    const { tokens } = await legacyOAuth2Client.getToken(code);
    console.log('Tokens received:', { 
      access_token: tokens.access_token ? 'Present' : 'Missing',
      refresh_token: tokens.refresh_token ? 'Present' : 'Missing' 
    });
    
    // Update user with Gmail tokens
    const updatedUser = await User.findByIdAndUpdate(
      req.user._id, 
      {
        gmailAccessToken: tokens.access_token,
        gmailRefreshToken: tokens.refresh_token || '',
        isGmailConnected: true
      },
      { new: true }
    );

    console.log('User updated successfully, Gmail connected:', updatedUser.isGmailConnected);
    res.json({ message: 'Gmail connected successfully' });
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).json({ 
      message: 'Failed to connect Gmail', 
      error: error.message 
    });
  }
});

// Enhanced Gmail scan with pattern analysis
router.post('/scan', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    
    if (!user.isGmailConnected || !user.gmailAccessToken) {
      return res.status(400).json({ message: 'Gmail not connected' });
    }

    console.log('Scanning Gmail for user:', req.user._id);

    // Set up Gmail API client
    oauth2Client.setCredentials({
      access_token: user.gmailAccessToken,
      refresh_token: user.gmailRefreshToken
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Enhanced query for comprehensive subscription detection
    const queries = [
      // Core subscription terms
      'subject:(subscription OR billing OR invoice OR payment OR renewal OR charged OR receipt) -is:spam newer_than:1y',
      
      // Payment and billing terms
      'subject:(payment OR paid OR charge OR bill OR invoice OR receipt OR membership) -is:spam newer_than:1y',
      
      // Subscription services keywords
      'subject:(monthly OR annual OR plan OR premium OR pro OR plus) -is:spam newer_than:1y',
      
      // Sender-based queries for subscription services
      'from:(noreply OR billing OR payment OR subscription OR support OR accounts) -is:spam newer_than:1y',
      
      // Specific subscription services
      'from:(webflow OR paddle OR stripe OR paypal OR namecheap OR puregym OR anthropic OR leonardo OR fal.ai) -is:spam newer_than:1y',
      
      // More subscription services
      'from:(netflix OR spotify OR adobe OR microsoft OR google OR apple OR github OR figma OR canva) -is:spam newer_than:1y',
      
      // Cancellation emails
      'subject:(cancelled OR canceled OR ended OR terminated OR expired) (subscription OR membership OR plan) -is:spam newer_than:6m',
      
      // Receipt and confirmation emails
      'subject:(receipt OR confirmation OR thank OR welcome) (subscription OR payment OR purchase) -is:spam newer_than:6m',
      
      // Membership and gym subscriptions
      'subject:(membership OR gym OR fitness) (invoice OR payment OR billing OR fee) -is:spam newer_than:1y',
      
      // Hosting and domain services
      'subject:(domain OR hosting OR cdn OR server OR ssl) (renewal OR payment OR invoice OR billing) -is:spam newer_than:1y'
    ];
    
    console.log('Searching Gmail with enhanced queries');
    
    const allMessages = [];
    
    // Collect messages from all queries
    for (const query of queries) {
      try {
        const response = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: 50
        });
        
        const messages = response.data.messages || [];
        allMessages.push(...messages);
      } catch (error) {
        console.error('Error with query:', query, error.message);
      }
    }

    // Remove duplicates
    const uniqueMessages = allMessages.filter((msg, index, self) => 
      index === self.findIndex(m => m.id === msg.id)
    );

    console.log(`Found ${uniqueMessages.length} unique potential subscription emails`);
    
    const emailData = [];

    // Process each message (limit to 100 for comprehensive analysis)
    for (const message of uniqueMessages.slice(0, 100)) {
      try {
        const messageData = await gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full'
        });

        emailData.push(messageData.data);
      } catch (error) {
        console.error('Error fetching email:', message.id, error.message);
        // Continue processing other emails
      }
    }

    // Initialize AI analyzer
    const aiAnalyzer = new AIEmailAnalyzer();
    
    let confirmedSubscriptions = [];
    let cancellations = [];
    
    if (aiAnalyzer.isConfigured()) {
      console.log('Using AI-powered email analysis...');
      
      // Use AI analysis
      const aiResults = await aiAnalyzer.batchAnalyzeEmails(emailData);
      
      // Convert AI results to subscription format and remove duplicates
      const allSubscriptions = aiResults.subscriptions
        .map(analysis => aiAnalyzer.convertToSubscriptionFormat(analysis))
        .filter(sub => sub !== null && sub.amount > 0); // Filter out zero amounts
      
      // Remove duplicates by service name (keep highest confidence)
      const uniqueSubscriptions = new Map();
      allSubscriptions.forEach(sub => {
        const key = sub.serviceName.toLowerCase().trim();
        if (!uniqueSubscriptions.has(key) || uniqueSubscriptions.get(key).confidence < sub.confidence) {
          uniqueSubscriptions.set(key, sub);
        }
      });
      
      confirmedSubscriptions = Array.from(uniqueSubscriptions.values());
      
      cancellations = aiResults.cancellations;
      
      console.log(`AI analysis complete:`);
      console.log(`- Confirmed subscriptions: ${confirmedSubscriptions.length}`);
      console.log(`- Detected cancellations: ${cancellations.length}`);
      console.log(`- Non-subscriptions: ${aiResults.nonSubscriptions.length}`);
      console.log(`- Errors: ${aiResults.errors.length}`);
    } else {
      console.log('OpenAI API key not found, falling back to pattern analysis...');
      
      // Fallback to pattern analysis
      const patternResults = analyzeSubscriptionPatterns(emailData);
      confirmedSubscriptions = patternResults.confirmedSubscriptions;
      cancellations = patternResults.cancellations;
      
      console.log(`Pattern analysis complete:`);
      console.log(`- Confirmed subscriptions: ${confirmedSubscriptions.length}`);
      console.log(`- Detected cancellations: ${cancellations.length}`);
    }

    // Check for existing subscriptions to avoid duplicates
    const existingSubscriptions = await Subscription.find({
      userId: req.user._id,
      isActive: true
    });

    const existingServiceNames = existingSubscriptions.map(s => s.serviceName.toLowerCase());
    
    // Filter out already existing subscriptions
    const newSubscriptions = confirmedSubscriptions.filter(sub => 
      !existingServiceNames.includes(sub.serviceName.toLowerCase())
    );

    res.json({ 
      detectedSubscriptions: newSubscriptions,
      cancellations,
      existingCount: confirmedSubscriptions.length - newSubscriptions.length,
      totalProcessed: emailData.length
    });
  } catch (error) {
    console.error('Gmail scan error:', error);
    
    // Check if it's an authentication error
    if (error.code === 401 || error.message.includes('invalid_grant')) {
      // Token expired, disconnect Gmail
      await User.findByIdAndUpdate(req.user._id, {
        gmailAccessToken: '',
        gmailRefreshToken: '',
        isGmailConnected: false
      });
      return res.status(401).json({ 
        message: 'Gmail access expired. Please reconnect your Gmail account.' 
      });
    }
    
    res.status(500).json({ 
      message: 'Failed to scan Gmail', 
      error: error.message 
    });
  }
});

// Enhanced import with cancellation handling
router.post('/import', auth, async (req, res) => {
  try {
    const { subscriptions, cancellations } = req.body;
    
    if (!subscriptions || !Array.isArray(subscriptions)) {
      return res.status(400).json({ message: 'Invalid subscriptions data' });
    }

    console.log(`Importing ${subscriptions.length} subscriptions and ${cancellations?.length || 0} cancellations for user:`, req.user._id);
    
    const importedSubscriptions = [];
    const processedCancellations = [];
    const errors = [];
    
    // Process cancellations first
    if (cancellations && Array.isArray(cancellations)) {
      for (const cancellation of cancellations) {
        try {
          const existing = await Subscription.findOne({
            userId: req.user._id,
            serviceName: { $regex: new RegExp(cancellation.serviceName.trim(), 'i') },
            isActive: true
          });
          
          if (existing) {
            existing.cancelSubscription(`Cancelled via email: ${cancellation.subject}`);
            await existing.save();
            processedCancellations.push(existing);
            console.log('Cancelled subscription:', existing.serviceName);
          }
        } catch (error) {
          console.error('Error processing cancellation:', cancellation.serviceName, error.message);
        }
      }
    }
    
    // Process subscriptions
    for (const subData of subscriptions) {
      try {
        console.log('Processing subscription data:', {
          serviceName: subData.serviceName,
          amount: subData.amount,
          currency: subData.currency,
          renewalDay: subData.renewalDay,
          nextRenewal: subData.nextRenewal,
          confidence: subData.confidence,
          paymentCount: subData.paymentCount
        });

        // Validate required fields
        if (!subData.serviceName || !subData.amount || !subData.currency || !subData.renewalDay) {
          errors.push(`Missing required fields for ${subData.serviceName || 'Unknown'}`);
          continue;
        }

        // Enhanced renewal date calculation based on last payment date
        let nextRenewal = subData.nextRenewal;
        let renewalDay = subData.renewalDay;
        
        // Use last payment date to determine proper renewal day if available
        if (subData.date) {
          const lastPaymentDate = new Date(subData.date);
          renewalDay = lastPaymentDate.getDate();
          console.log(`Using renewal day ${renewalDay} from last payment date: ${lastPaymentDate.toISOString()}`);
        }
        
        if (!nextRenewal || isNaN(new Date(nextRenewal).getTime())) {
          const now = new Date();
          const lastPaymentDate = subData.date ? new Date(subData.date) : now;
          
          // Calculate next renewal based on last payment date
          nextRenewal = new Date(lastPaymentDate.getFullYear(), lastPaymentDate.getMonth() + 1, renewalDay || lastPaymentDate.getDate());
          
          // If the calculated date is in the past, move it to next month
          if (nextRenewal <= now) {
            nextRenewal.setMonth(nextRenewal.getMonth() + 1);
          }
          
          console.log('Calculated nextRenewal based on payment date:', nextRenewal);
        }
        
        // Final validation - ensure renewalDay is properly set
        if (!renewalDay && nextRenewal) {
          renewalDay = new Date(nextRenewal).getDate();
        }

        // Check if subscription already exists
        const existing = await Subscription.findOne({
          userId: req.user._id,
          serviceName: { $regex: new RegExp(subData.serviceName.trim(), 'i') },
          isActive: true
        });
        
        if (!existing) {
          const subscriptionData = {
            userId: req.user._id,
            serviceName: subData.serviceName.trim(),
            amount: parseFloat(subData.amount),
            currency: subData.currency,
            renewalDay: parseInt(renewalDay || subData.renewalDay || 1),
            nextRenewal: new Date(nextRenewal),
            category: subData.category || 'Other',
            description: subData.description || `Auto-detected from Gmail`,
            detectedFromEmail: true,
            // Enhanced fields from pattern analysis
            confidenceScore: typeof subData.confidence === 'number' ? subData.confidence : (subData.confidenceScore || 0),
            hasPaymentHistory: subData.hasPaymentHistory || false,
            hasConsistentRenewalDate: subData.hasConsistentRenewalDate || false,
            isRecurring: subData.isRecurring || false,
            paymentCount: subData.paymentCount || 0,
            lastPaymentDate: subData.date ? new Date(subData.date) : new Date(),
            // Add recency validation fields
            isRecentPayment: subData.date ? (new Date() - new Date(subData.date)) / (1000 * 60 * 60 * 24) <= 60 : false, // Within 60 days
            daysSinceLastPayment: subData.date ? Math.floor((new Date() - new Date(subData.date)) / (1000 * 60 * 60 * 24)) : 0
          };

          console.log('Creating subscription with enhanced data:', subscriptionData);

          const subscription = new Subscription(subscriptionData);
          
          // Add payment history if available
          if (subData.date && subData.amount) {
            subscription.addPayment({
              date: new Date(subData.date),
              amount: subData.amount,
              currency: subData.currency,
              subject: subData.subject,
              confidence: typeof subData.confidence === 'number' ? subData.confidence : (subData.confidenceScore || 0)
            });
          }
          
          await subscription.save();
          
          importedSubscriptions.push(subscription);
          console.log('Successfully imported:', subscription.serviceName);
        } else {
          console.log('Subscription already exists:', subData.serviceName);
          errors.push(`${subData.serviceName} already exists`);
        }
      } catch (error) {
        console.error('Error importing subscription:', subData.serviceName, error.message);
        errors.push(`Failed to import ${subData.serviceName}: ${error.message}`);
      }
    }

    console.log(`Import completed: ${importedSubscriptions.length} imported, ${processedCancellations.length} cancelled, ${errors.length} errors`);

    // Return success even if some imports failed
    const message = importedSubscriptions.length > 0 
      ? `Successfully imported ${importedSubscriptions.length} subscription${importedSubscriptions.length !== 1 ? 's' : ''}${processedCancellations.length > 0 ? ` and processed ${processedCancellations.length} cancellation${processedCancellations.length !== 1 ? 's' : ''}` : ''}${errors.length > 0 ? ` (${errors.length} skipped)` : ''}`
      : `No new subscriptions imported${errors.length > 0 ? ` (${errors.length} had issues)` : ''}`;

    res.json({ 
      message,
      importedSubscriptions,
      processedCancellations,
      errors: errors.slice(0, 5) // Limit error messages
    });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ 
      message: 'Failed to import subscriptions', 
      error: error.message 
    });
  }
});

// Also add this helper route for testing the email parser
router.post('/test-parser', auth, async (req, res) => {
  try {
    const { emailContent } = req.body;
    
    // Mock email data structure
    const mockEmailData = {
      payload: {
        headers: [
          { name: 'Subject', value: emailContent.subject || 'Test Subject' },
          { name: 'From', value: emailContent.from || 'test@example.com' },
          { name: 'Date', value: new Date().toISOString() }
        ],
        body: {
          data: Buffer.from(emailContent.body || 'Test email body').toString('base64')
        }
      }
    };

    const { parseEmailForSubscription, analyzeSubscriptionPatterns } = require('../utils/emailParser');
    const result = parseEmailForSubscription(mockEmailData);
    
    res.json({ 
      input: emailContent,
      parsed: result,
      success: !!result
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Disconnect Gmail
router.post('/disconnect', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, {
      gmailAccessToken: '',
      gmailRefreshToken: '',
      isGmailConnected: false
    });

    console.log('Gmail disconnected for user:', req.user._id);
    res.json({ message: 'Gmail disconnected successfully' });
  } catch (error) {
    console.error('Disconnect error:', error);
    res.status(500).json({ message: 'Failed to disconnect Gmail' });
  }
});

// AI-powered subscription scan route
router.post('/scan-ai', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    
    if (!user.isGmailConnected || !user.gmailAccessToken) {
      return res.status(400).json({ message: 'Gmail not connected' });
    }

    const aiAnalyzer = new AIEmailAnalyzer();
    
    if (!aiAnalyzer.isConfigured()) {
      return res.status(400).json({ 
        message: 'OpenAI API key not configured. Please add OPENAI_API_KEY to your environment variables.' 
      });
    }

    console.log('Starting AI-powered Gmail scan for user:', req.user._id);

    // Set up Gmail API client
    oauth2Client.setCredentials({
      access_token: user.gmailAccessToken,
      refresh_token: user.gmailRefreshToken
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Enhanced query for comprehensive subscription detection
    const queries = [
      // Core subscription terms
      'subject:(subscription OR billing OR invoice OR payment OR renewal OR charged OR receipt) -is:spam newer_than:1y',
      
      // Payment and billing terms
      'subject:(payment OR paid OR charge OR bill OR invoice OR receipt OR membership) -is:spam newer_than:1y',
      
      // Subscription services keywords
      'subject:(monthly OR annual OR plan OR premium OR pro OR plus) -is:spam newer_than:1y',
      
      // Sender-based queries for subscription services
      'from:(noreply OR billing OR payment OR subscription OR support OR accounts) -is:spam newer_than:1y',
      
      // Specific subscription services
      'from:(webflow OR paddle OR stripe OR paypal OR namecheap OR puregym OR anthropic OR leonardo OR fal.ai) -is:spam newer_than:1y',
      
      // More subscription services
      'from:(netflix OR spotify OR adobe OR microsoft OR google OR apple OR github OR figma OR canva) -is:spam newer_than:1y',
      
      // Cancellation emails
      'subject:(cancelled OR canceled OR ended OR terminated OR expired) (subscription OR membership OR plan) -is:spam newer_than:6m',
      
      // Receipt and confirmation emails
      'subject:(receipt OR confirmation OR thank OR welcome) (subscription OR payment OR purchase) -is:spam newer_than:6m',
      
      // Membership and gym subscriptions
      'subject:(membership OR gym OR fitness) (invoice OR payment OR billing OR fee) -is:spam newer_than:1y',
      
      // Hosting and domain services
      'subject:(domain OR hosting OR cdn OR server OR ssl) (renewal OR payment OR invoice OR billing) -is:spam newer_than:1y'
    ];
    
    console.log('Searching Gmail with enhanced queries');
    
    const allMessages = [];
    
    // Collect messages from all queries
    for (const query of queries) {
      try {
        const response = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: 50
        });
        
        const messages = response.data.messages || [];
        allMessages.push(...messages);
      } catch (error) {
        console.error('Error with query:', query, error.message);
      }
    }

    // Remove duplicates
    const uniqueMessages = allMessages.filter((msg, index, self) => 
      index === self.findIndex(m => m.id === msg.id)
    );

    console.log(`Found ${uniqueMessages.length} unique potential subscription emails`);
    
    const emailData = [];

    // Process each message (limit to 100 for comprehensive analysis)
    for (const message of uniqueMessages.slice(0, 100)) {
      try {
        const messageData = await gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full'
        });

        emailData.push(messageData.data);
      } catch (error) {
        console.error('Error fetching email:', message.id, error.message);
        // Continue processing other emails
      }
    }

    // Use AI analysis
    const aiResults = await aiAnalyzer.batchAnalyzeEmails(emailData);
    
    // Convert AI results to subscription format and remove duplicates
    const allSubscriptions = aiResults.subscriptions
      .map(analysis => aiAnalyzer.convertToSubscriptionFormat(analysis))
      .filter(sub => sub !== null && sub.amount > 0); // Filter out zero amounts
    
    // Remove duplicates by service name (keep highest confidence)
    const uniqueSubscriptions = new Map();
    allSubscriptions.forEach(sub => {
      const key = sub.serviceName.toLowerCase().trim();
      if (!uniqueSubscriptions.has(key) || uniqueSubscriptions.get(key).confidence < sub.confidence) {
        uniqueSubscriptions.set(key, sub);
      }
    });
    
    const confirmedSubscriptions = Array.from(uniqueSubscriptions.values());
    
    console.log(`AI analysis complete:`);
    console.log(`- Confirmed subscriptions: ${confirmedSubscriptions.length}`);
    console.log(`- Detected cancellations: ${aiResults.cancellations.length}`);
    console.log(`- Non-subscriptions: ${aiResults.nonSubscriptions.length}`);
    console.log(`- Errors: ${aiResults.errors.length}`);

    // Check for existing subscriptions to avoid duplicates
    const existingSubscriptions = await Subscription.find({
      userId: req.user._id,
      isActive: true
    });

    const existingServiceNames = existingSubscriptions.map(s => s.serviceName.toLowerCase());
    
    // Filter out already existing subscriptions
    const newSubscriptions = confirmedSubscriptions.filter(sub => 
      !existingServiceNames.includes(sub.serviceName.toLowerCase())
    );

    res.json({ 
      detectedSubscriptions: newSubscriptions,
      cancellations: aiResults.cancellations,
      existingCount: confirmedSubscriptions.length - newSubscriptions.length,
      totalProcessed: emailData.length,
      nonSubscriptions: aiResults.nonSubscriptions.length,
      analysisMethod: 'AI-powered',
      aiInsights: {
        totalAnalyzed: emailData.length,
        subscriptionEmails: aiResults.subscriptions.length,
        cancellationEmails: aiResults.cancellations.length,
        promotionalEmails: aiResults.nonSubscriptions.length,
        errorCount: aiResults.errors.length
      }
    });
  } catch (error) {
    console.error('AI Gmail scan error:', error);
    
    // Check if it's an authentication error
    if (error.code === 401 || error.message.includes('invalid_grant')) {
      // Token expired, disconnect Gmail
      await User.findByIdAndUpdate(req.user._id, {
        gmailAccessToken: '',
        gmailRefreshToken: '',
        isGmailConnected: false
      });
      return res.status(401).json({ 
        message: 'Gmail access expired. Please reconnect your Gmail account.' 
      });
    }
    
    res.status(500).json({ 
      message: 'Failed to scan Gmail with AI', 
      error: error.message 
    });
  }
});

// Test Gmail connection
router.get('/test', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    
    if (!user.isGmailConnected || !user.gmailAccessToken) {
      return res.status(400).json({ message: 'Gmail not connected' });
    }

    // Set up Gmail API client
    oauth2Client.setCredentials({
      access_token: user.gmailAccessToken,
      refresh_token: user.gmailRefreshToken
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Test API call
    const profile = await gmail.users.getProfile({ userId: 'me' });
    
    res.json({ 
      message: 'Gmail connection is working',
      emailAddress: profile.data.emailAddress,
      messagesTotal: profile.data.messagesTotal
    });
  } catch (error) {
    console.error('Gmail test error:', error);
    res.status(500).json({ 
      message: 'Gmail connection test failed', 
      error: error.message 
    });
  }
});

// Multiple Gmail accounts management

// Get all connected Gmail accounts
router.get('/accounts', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    
    // Migration: Convert old single Gmail connection to new multi-account format
    // Only migrate if user has old connection but no multi-accounts AND old connection is still valid
    if (user.isGmailConnected && user.gmailAccessToken && user.gmailAccounts.length === 0) {
      console.log('Migrating single Gmail account to multi-account format for user:', req.user._id);
      
      try {
        // Get the email address from the existing Gmail connection
        oauth2Client.setCredentials({
          access_token: user.gmailAccessToken,
          refresh_token: user.gmailRefreshToken
        });
        
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        const emailAddress = profile.data.emailAddress;
        
        // Add to new multi-account format
        user.gmailAccounts.push({
          email: emailAddress,
          accessToken: user.gmailAccessToken,
          refreshToken: user.gmailRefreshToken,
          isConnected: true,
          connectedAt: new Date()
        });
        
        // Clear old single-account fields to prevent re-migration
        user.isGmailConnected = false;
        user.gmailAccessToken = '';
        user.gmailRefreshToken = '';
        
        await user.save();
        console.log('Successfully migrated Gmail account:', emailAddress);
      } catch (migrationError) {
        console.error('Failed to migrate Gmail account:', migrationError);
        // If migration fails, mark old connection as disconnected
        user.isGmailConnected = false;
        user.gmailAccessToken = '';
        user.gmailRefreshToken = '';
        await user.save();
      }
    }
    
    const accounts = user.gmailAccounts.map(account => ({
      id: account._id,
      email: account.email,
      isConnected: account.isConnected,
      lastScanDate: account.lastScanDate,
      connectedAt: account.connectedAt
    }));
    
    res.json({ 
      accounts,
      maxAccounts: 3,
      canAddMore: accounts.length < 3
    });
  } catch (error) {
    console.error('Error fetching Gmail accounts:', error);
    res.status(500).json({ message: 'Failed to fetch Gmail accounts' });
  }
});

// Track processed authorization codes to prevent duplicates
const processedCodes = new Set();

// Connect new Gmail account
router.post('/accounts/connect', auth, async (req, res) => {
  try {
    console.log('=== Gmail Multi-Account Connect API Called ===');
    console.log('User ID:', req.user._id);
    console.log('Request body:', req.body);
    
    const { code } = req.body;
    const user = await User.findById(req.user._id);
    
    console.log('User found:', !!user);
    console.log('Current gmail accounts count:', user?.gmailAccounts?.length || 0);
    
    if (!code) {
      console.log('ERROR: No authorization code provided');
      return res.status(400).json({ message: 'Authorization code is required' });
    }

    // Prevent duplicate code usage
    const codeKey = `${req.user._id}-${code.substring(0, 10)}`;
    if (processedCodes.has(codeKey)) {
      console.log('ERROR: Authorization code already processed');
      return res.status(400).json({ message: 'Authorization code already used' });
    }
    processedCodes.add(codeKey);

    // Clean up old codes (keep only last 100)
    if (processedCodes.size > 100) {
      const oldCodes = Array.from(processedCodes).slice(0, 50);
      oldCodes.forEach(code => processedCodes.delete(code));
    }

    // Check if user already has 3 accounts
    if (user.gmailAccounts.length >= 3) {
      return res.status(400).json({ message: 'Maximum of 3 Gmail accounts allowed' });
    }

    console.log('Connecting new Gmail account for user:', req.user._id);

    // Create a fresh OAuth client instance for this connection
    const newAccountOAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || 'https://subwallet.up.railway.app/auth/callback'
    );

    // Exchange code for tokens
    const { tokens } = await newAccountOAuth2Client.getToken(code);
    console.log('Tokens received for new account');
    
    // Get user profile to get email address
    newAccountOAuth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: newAccountOAuth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const emailAddress = profile.data.emailAddress;
    
    // Check if this email is already connected
    const existingAccount = user.gmailAccounts.find(acc => acc.email === emailAddress);
    if (existingAccount) {
      return res.status(400).json({ message: 'This Gmail account is already connected' });
    }
    
    // Add new account to user
    user.gmailAccounts.push({
      email: emailAddress,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || '',
      isConnected: true,
      connectedAt: new Date()
    });
    
    await user.save();

    console.log('New Gmail account connected:', emailAddress);
    res.json({ 
      message: 'Gmail account connected successfully',
      email: emailAddress,
      totalAccounts: user.gmailAccounts.length
    });
  } catch (error) {
    console.error('Error connecting Gmail account:', error);
    
    // Remove the code from processed set if it failed
    const codeKey = `${req.user._id}-${req.body.code?.substring(0, 10)}`;
    processedCodes.delete(codeKey);
    
    // Handle specific OAuth errors
    if (error.message?.includes('invalid_grant')) {
      return res.status(400).json({ 
        message: 'Authorization code expired or invalid. Please try connecting again.',
        error: 'invalid_grant'
      });
    }
    
    res.status(500).json({ 
      message: 'Failed to connect Gmail account', 
      error: error.message 
    });
  }
});

// Disconnect specific Gmail account
router.delete('/accounts/:accountId', auth, async (req, res) => {
  try {
    console.log('=== Disconnect Gmail Account API Called ===');
    console.log('User ID:', req.user._id);
    console.log('Account ID to disconnect:', req.params.accountId);
    
    const { accountId } = req.params;
    const user = await User.findById(req.user._id);
    
    console.log('User found:', !!user);
    console.log('Current gmail accounts:', user.gmailAccounts.map(acc => ({ id: acc._id.toString(), email: acc.email })));
    
    const accountIndex = user.gmailAccounts.findIndex(acc => acc._id.toString() === accountId);
    console.log('Account index found:', accountIndex);
    
    if (accountIndex === -1) {
      console.log('ERROR: Gmail account not found');
      return res.status(404).json({ message: 'Gmail account not found' });
    }
    
    const removedAccount = user.gmailAccounts[accountIndex];
    console.log('Removing account:', removedAccount.email);
    
    user.gmailAccounts.splice(accountIndex, 1);
    
    // If this was the last account, also clear any old single-account fields
    if (user.gmailAccounts.length === 0) {
      user.isGmailConnected = false;
      user.gmailAccessToken = '';
      user.gmailRefreshToken = '';
      console.log('Cleared old single-account Gmail fields');
    }
    
    await user.save();
    
    console.log('Gmail account disconnected successfully:', removedAccount.email);
    res.json({ 
      message: 'Gmail account disconnected successfully',
      email: removedAccount.email,
      remainingAccounts: user.gmailAccounts.length
    });
  } catch (error) {
    console.error('Error disconnecting Gmail account:', error);
    res.status(500).json({ message: 'Failed to disconnect Gmail account' });
  }
});

// Test route for debugging
router.get('/accounts/:accountId/test', (req, res) => {
  console.log('🧪 TEST ROUTE HIT:', req.params.accountId);
  res.json({ message: 'Test route working', accountId: req.params.accountId });
});

// Scan specific Gmail account
router.post('/accounts/:accountId/scan', auth, async (req, res) => {
  try {
    console.log('=== Gmail Account Scan API Called ===');
    console.log('User ID:', req.user._id);
    console.log('Account ID to scan:', req.params.accountId);
    
    const { accountId } = req.params;
    const user = await User.findById(req.user._id);
    
    console.log('User found:', !!user);
    console.log('User gmail accounts:', user.gmailAccounts.map(acc => ({ id: acc._id.toString(), email: acc.email, connected: acc.isConnected })));
    
    const account = user.gmailAccounts.find(acc => acc._id.toString() === accountId);
    console.log('Account found:', !!account);
    
    if (!account) {
      console.log('ERROR: Gmail account not found');
      return res.status(404).json({ message: 'Gmail account not found' });
    }
    
    console.log('Account details:', { email: account.email, connected: account.isConnected });
    
    if (!account.isConnected) {
      console.log('ERROR: Gmail account is not connected');
      return res.status(400).json({ message: 'Gmail account is not connected' });
    }

    console.log('Starting scan for Gmail account:', account.email);

    // Set up Gmail API client for this specific account
    oauth2Client.setCredentials({
      access_token: account.accessToken,
      refresh_token: account.refreshToken
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Same scanning logic as before, but for specific account
    const queries = [
      'subject:(subscription OR billing OR invoice OR payment OR renewal OR charged OR receipt) -is:spam newer_than:1y',
      'subject:(payment OR paid OR charge OR bill OR invoice OR receipt OR membership) -is:spam newer_than:1y',
      'subject:(monthly OR annual OR plan OR premium OR pro OR plus) -is:spam newer_than:1y',
      'from:(noreply OR billing OR payment OR subscription OR support OR accounts) -is:spam newer_than:1y',
      'from:(webflow OR paddle OR stripe OR paypal OR namecheap OR puregym OR anthropic OR leonardo OR fal.ai) -is:spam newer_than:1y',
      'from:(netflix OR spotify OR adobe OR microsoft OR google OR apple OR github OR figma OR canva) -is:spam newer_than:1y',
      'subject:(cancelled OR canceled OR ended OR terminated OR expired) (subscription OR membership OR plan) -is:spam newer_than:6m',
      'subject:(receipt OR confirmation OR thank OR welcome) (subscription OR payment OR purchase) -is:spam newer_than:6m',
      'subject:(membership OR gym OR fitness) (invoice OR payment OR billing OR fee) -is:spam newer_than:1y',
      'subject:(domain OR hosting OR cdn OR server OR ssl) (renewal OR payment OR invoice OR billing) -is:spam newer_than:1y'
    ];
    
    const allMessages = [];
    
    // Collect messages from all queries
    for (const query of queries) {
      try {
        const response = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: 50
        });
        
        const messages = response.data.messages || [];
        allMessages.push(...messages);
      } catch (error) {
        console.error('Error with query:', query, error.message);
      }
    }

    // Remove duplicates
    const uniqueMessages = allMessages.filter((msg, index, self) => 
      index === self.findIndex(m => m.id === msg.id)
    );

    console.log(`Found ${uniqueMessages.length} unique potential subscription emails in ${account.email}`);
    
    // Keyword pre-filtering function
    const isLikelySubscriptionEmail = (subject, from) => {
      const subjectLower = subject.toLowerCase();
      const fromLower = from.toLowerCase();
      
      // High-priority subscription keywords in subject
      const subscriptionKeywords = [
        'payment', 'charged', 'invoice', 'receipt', 'billing', 'subscription', 
        'renewal', 'monthly', 'annual', 'membership', 'plan upgraded', 'plan renewed',
        'payment confirmation', 'payment successful', 'payment processed',
        'your receipt', 'thank you for your payment', 'payment notification',
        'auto-renewal', 'recurring payment', 'subscription active'
      ];
      
      // Service provider keywords in from field
      const serviceProviders = [
        'noreply', 'billing', 'payment', 'support', 'accounts', 'no-reply',
        'stripe', 'paypal', 'paddle', 'apple', 'google', 'microsoft',
        'netflix', 'spotify', 'adobe', 'anthropic', 'openai', 'github',
        'webflow', 'namecheap', 'puregym', 'leonardo', 'fal.ai', 'canva'
      ];
      
      // Exclude promotional/marketing emails
      const excludeKeywords = [
        'newsletter', 'digest', 'update available', 'new feature', 'discount',
        'sale', 'offer', 'promotion', 'free trial', 'get started', 'welcome to',
        'verify your', 'confirm your', 'password', 'security alert', 'login',
        'unsubscribe', 'preferences', 'settings', 'activate', 'setup'
      ];
      
      // Check for exclusion keywords first
      if (excludeKeywords.some(keyword => subjectLower.includes(keyword))) {
        return false;
      }
      
      // Check for subscription keywords in subject
      const hasSubscriptionKeyword = subscriptionKeywords.some(keyword => 
        subjectLower.includes(keyword)
      );
      
      // Check for service provider in from field
      const hasServiceProvider = serviceProviders.some(provider => 
        fromLower.includes(provider)
      );
      
      // Email is likely subscription if it has keywords OR comes from known providers
      return hasSubscriptionKeyword || hasServiceProvider;
    };
    
    const emailData = [];
    const filteredEmails = [];

    // First pass: Fetch and filter emails using keywords
    console.log('Pre-filtering emails using keyword analysis...');
    for (const message of uniqueMessages.slice(0, 100)) {
      try {
        const messageData = await gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date']
        });

        const headers = messageData.data.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        
        if (isLikelySubscriptionEmail(subject, from)) {
          filteredEmails.push(message);
        }
      } catch (error) {
        console.error('Error pre-filtering email:', message.id, error.message);
      }
    }
    
    console.log(`Pre-filtering complete: ${filteredEmails.length}/${uniqueMessages.slice(0, 100).length} emails passed keyword filter`);

    // Second pass: Fetch full content for filtered emails
    for (const message of filteredEmails.slice(0, 50)) { // Limit to 50 for AI analysis
      try {
        const messageData = await gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full'
        });

        emailData.push(messageData.data);
      } catch (error) {
        console.error('Error fetching email:', message.id, error.message);
      }
    }

    // Initialize AI analyzer
    const aiAnalyzer = new AIEmailAnalyzer();
    
    let confirmedSubscriptions = [];
    let cancellations = [];
    
    if (aiAnalyzer.isConfigured()) {
      console.log('Using AI-powered email analysis for', account.email);
      
      const aiResults = await aiAnalyzer.batchAnalyzeEmails(emailData);
      
      const allSubscriptions = aiResults.subscriptions
        .map(analysis => aiAnalyzer.convertToSubscriptionFormat(analysis))
        .filter(sub => sub !== null && sub.amount > 0);
      
      const uniqueSubscriptions = new Map();
      allSubscriptions.forEach(sub => {
        const key = sub.serviceName.toLowerCase().trim();
        if (!uniqueSubscriptions.has(key) || uniqueSubscriptions.get(key).confidence < sub.confidence) {
          uniqueSubscriptions.set(key, sub);
        }
      });
      
      confirmedSubscriptions = Array.from(uniqueSubscriptions.values());
      cancellations = aiResults.cancellations;
      
      console.log(`AI analysis complete for ${account.email}:`);
      console.log(`- Confirmed subscriptions: ${confirmedSubscriptions.length}`);
      console.log(`- Detected cancellations: ${cancellations.length}`);
    } else {
      console.log('OpenAI API key not found, falling back to pattern analysis for', account.email);
      
      const patternResults = analyzeSubscriptionPatterns(emailData);
      confirmedSubscriptions = patternResults.confirmedSubscriptions;
      cancellations = patternResults.cancellations;
    }

    // Check for existing subscriptions to avoid duplicates
    const existingSubscriptions = await Subscription.find({
      userId: req.user._id,
      isActive: true
    });

    const existingServiceNames = existingSubscriptions.map(s => s.serviceName.toLowerCase());
    
    // Filter out already existing subscriptions
    const newSubscriptions = confirmedSubscriptions.filter(sub => 
      !existingServiceNames.includes(sub.serviceName.toLowerCase())
    );

    // Update last scan date
    account.lastScanDate = new Date();
    await user.save();

    res.json({ 
      detectedSubscriptions: newSubscriptions,
      cancellations,
      existingCount: confirmedSubscriptions.length - newSubscriptions.length,
      totalProcessed: emailData.length,
      scannedAccount: account.email,
      scanDate: account.lastScanDate
    });
  } catch (error) {
    console.error('Gmail account scan error:', error);
    
    // Check if it's an authentication error
    if (error.code === 401 || error.message.includes('invalid_grant')) {
      // Token expired, mark account as disconnected
      const user = await User.findById(req.user._id);
      const account = user.gmailAccounts.find(acc => acc._id.toString() === req.params.accountId);
      if (account) {
        account.isConnected = false;
        await user.save();
      }
      
      return res.status(401).json({ 
        message: 'Gmail access expired. Please reconnect this Gmail account.' 
      });
    }
    
    res.status(500).json({ 
      message: 'Failed to scan Gmail account', 
      error: error.message 
    });
  }
});

// Scan all connected Gmail accounts
router.post('/accounts/scan-all', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    
    const connectedAccounts = user.gmailAccounts.filter(acc => acc.isConnected);
    
    if (connectedAccounts.length === 0) {
      return res.status(400).json({ message: 'No Gmail accounts connected' });
    }

    console.log(`Scanning ${connectedAccounts.length} Gmail accounts for user:`, req.user._id);

    const allResults = [];
    const errors = [];

    for (const account of connectedAccounts) {
      try {
        console.log('Scanning account:', account.email);
        
        // Set up Gmail API client for this account
        oauth2Client.setCredentials({
          access_token: account.accessToken,
          refresh_token: account.refreshToken
        });

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Same scanning logic as single account
        const queries = [
          'subject:(subscription OR billing OR invoice OR payment OR renewal OR charged OR receipt) -is:spam newer_than:1y',
          'subject:(payment OR paid OR charge OR bill OR invoice OR receipt OR membership) -is:spam newer_than:1y',
          'subject:(monthly OR annual OR plan OR premium OR pro OR plus) -is:spam newer_than:1y',
          'from:(noreply OR billing OR payment OR subscription OR support OR accounts) -is:spam newer_than:1y',
          'from:(webflow OR paddle OR stripe OR paypal OR namecheap OR puregym OR anthropic OR leonardo OR fal.ai) -is:spam newer_than:1y',
          'from:(netflix OR spotify OR adobe OR microsoft OR google OR apple OR github OR figma OR canva) -is:spam newer_than:1y'
        ];
        
        const allMessages = [];
        
        for (const query of queries) {
          try {
            const response = await gmail.users.messages.list({
              userId: 'me',
              q: query,
              maxResults: 30 // Reduced for multiple accounts
            });
            
            const messages = response.data.messages || [];
            allMessages.push(...messages);
          } catch (error) {
            console.error('Error with query for', account.email, error.message);
          }
        }

        const uniqueMessages = allMessages.filter((msg, index, self) => 
          index === self.findIndex(m => m.id === msg.id)
        );

        const emailData = [];

        // Process messages (limit to 50 per account for performance)
        for (const message of uniqueMessages.slice(0, 50)) {
          try {
            const messageData = await gmail.users.messages.get({
              userId: 'me',
              id: message.id,
              format: 'full'
            });

            emailData.push(messageData.data);
          } catch (error) {
            console.error('Error fetching email from', account.email, error.message);
          }
        }

        // Analyze emails
        const aiAnalyzer = new AIEmailAnalyzer();
        let confirmedSubscriptions = [];
        let cancellations = [];
        
        if (aiAnalyzer.isConfigured()) {
          const aiResults = await aiAnalyzer.batchAnalyzeEmails(emailData);
          
          const allSubscriptions = aiResults.subscriptions
            .map(analysis => aiAnalyzer.convertToSubscriptionFormat(analysis))
            .filter(sub => sub !== null && sub.amount > 0);
          
          const uniqueSubscriptions = new Map();
          allSubscriptions.forEach(sub => {
            const key = sub.serviceName.toLowerCase().trim();
            if (!uniqueSubscriptions.has(key) || uniqueSubscriptions.get(key).confidence < sub.confidence) {
              uniqueSubscriptions.set(key, sub);
            }
          });
          
          confirmedSubscriptions = Array.from(uniqueSubscriptions.values());
          cancellations = aiResults.cancellations;
        } else {
          const patternResults = analyzeSubscriptionPatterns(emailData);
          confirmedSubscriptions = patternResults.confirmedSubscriptions;
          cancellations = patternResults.cancellations;
        }

        // Update last scan date
        account.lastScanDate = new Date();

        allResults.push({
          account: account.email,
          subscriptions: confirmedSubscriptions,
          cancellations: cancellations,
          processedEmails: emailData.length
        });

      } catch (error) {
        console.error('Error scanning account', account.email, error.message);
        errors.push({
          account: account.email,
          error: error.message
        });
        
        // If auth error, mark account as disconnected
        if (error.code === 401 || error.message.includes('invalid_grant')) {
          account.isConnected = false;
        }
      }
    }

    await user.save();

    // Combine all results
    const allSubscriptions = allResults.flatMap(result => result.subscriptions);
    const allCancellations = allResults.flatMap(result => result.cancellations);

    // Check for existing subscriptions to avoid duplicates
    const existingSubscriptions = await Subscription.find({
      userId: req.user._id,
      isActive: true
    });

    const existingServiceNames = existingSubscriptions.map(s => s.serviceName.toLowerCase());
    
    // Filter out already existing subscriptions
    const newSubscriptions = allSubscriptions.filter(sub => 
      !existingServiceNames.includes(sub.serviceName.toLowerCase())
    );

    // Remove duplicates across accounts
    const uniqueNewSubscriptions = new Map();
    newSubscriptions.forEach(sub => {
      const key = sub.serviceName.toLowerCase().trim();
      if (!uniqueNewSubscriptions.has(key) || uniqueNewSubscriptions.get(key).confidence < sub.confidence) {
        uniqueNewSubscriptions.set(key, sub);
      }
    });

    const finalSubscriptions = Array.from(uniqueNewSubscriptions.values());

    console.log(`Scan complete for ${connectedAccounts.length} accounts:`);
    console.log(`- Total unique subscriptions found: ${finalSubscriptions.length}`);
    console.log(`- Total cancellations found: ${allCancellations.length}`);
    console.log(`- Errors: ${errors.length}`);

    res.json({
      detectedSubscriptions: finalSubscriptions,
      cancellations: allCancellations,
      scannedAccounts: allResults.map(r => ({
        email: r.account,
        subscriptionsFound: r.subscriptions.length,
        cancellationsFound: r.cancellations.length,
        emailsProcessed: r.processedEmails
      })),
      errors: errors,
      totalProcessed: allResults.reduce((sum, r) => sum + r.processedEmails, 0),
      existingCount: allSubscriptions.length - finalSubscriptions.length
    });

  } catch (error) {
    console.error('Multi-account scan error:', error);
    res.status(500).json({ 
      message: 'Failed to scan Gmail accounts', 
      error: error.message 
    });
  }
});

module.exports = router;