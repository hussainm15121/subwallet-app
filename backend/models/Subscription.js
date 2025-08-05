const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  serviceName: {
    type: String,
    required: true,
    trim: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    enum: ['USD', 'EUR', 'GBP', 'AED'],
    required: true
  },
  renewalDay: {
    type: Number,
    required: true,
    min: 1,
    max: 31
  },
  nextRenewal: {
    type: Date,
    required: false // Will be set automatically by pre-save middleware
  },
  category: {
    type: String,
    enum: [
      'Entertainment & Media',
      'Software & Productivity', 
      'Health & Fitness',
      'Web Services & Hosting',
      'Gaming',
      'Education & Learning',
      'Food & Delivery',
      'Transportation',
      'Finance & Banking',
      'Communication',
      'News & Magazines',
      'Music & Audio',
      'Video & Streaming',
      'Design & Creative',
      'Business & Professional',
      'Security & Privacy',
      'Storage & Cloud',
      'Shopping & Retail',
      'Utilities & Services',
      'Travel & Tourism',
      'Sports & Recreation',
      'Other'
    ],
    default: 'Other'
  },
  description: {
    type: String,
    default: ''
  },
  isActive: {
    type: Boolean,
    default: true
  },
  detectedFromEmail: {
    type: Boolean,
    default: false
  },
  // New fields for enhanced tracking
  paymentHistory: [{
    date: Date,
    amount: Number,
    currency: String,
    emailSubject: String,
    confidence: Number
  }],
  cancellationDate: {
    type: Date,
    default: null
  },
  cancellationReason: {
    type: String,
    default: ''
  },
  lastPaymentDate: {
    type: Date,
    default: null
  },
  isRecurring: {
    type: Boolean,
    default: false
  },
  confidenceScore: {
    type: Number,
    default: 0
  },
  hasPaymentHistory: {
    type: Boolean,
    default: false
  },
  hasConsistentRenewalDate: {
    type: Boolean,
    default: false
  },
  paymentCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Calculate next renewal date
subscriptionSchema.methods.calculateNextRenewal = function() {
  const now = new Date();
  const nextRenewal = new Date(now.getFullYear(), now.getMonth(), this.renewalDay);
  
  if (nextRenewal <= now) {
    nextRenewal.setMonth(nextRenewal.getMonth() + 1);
  }
  
  // Handle end of month edge cases
  if (nextRenewal.getDate() !== this.renewalDay) {
    nextRenewal.setDate(0); // Set to last day of previous month
  }
  
  return nextRenewal;
};

// Enhanced method to add payment record with consistency analysis
subscriptionSchema.methods.addPayment = function(paymentData) {
  this.paymentHistory.push({
    date: paymentData.date || new Date(),
    amount: paymentData.amount,
    currency: paymentData.currency || 'USD',
    emailSubject: paymentData.subject || '',
    confidence: paymentData.confidence || 0
  });
  
  this.lastPaymentDate = paymentData.date || new Date();
  this.paymentCount = this.paymentHistory.length;
  
  // Analyze payment patterns if we have multiple payments
  if (this.paymentCount > 1) {
    const analysis = this.analyzePaymentConsistency();
    this.isRecurring = true;
    this.hasConsistentRenewalDate = analysis.hasMonthlyPattern;
    this.hasPaymentHistory = true;
    
    // Update confidence score based on pattern analysis
    if (analysis.isConsistent && analysis.hasMonthlyPattern) {
      this.confidenceScore = Math.max(this.confidenceScore, 8);
    }
  }
};

// Method to cancel subscription
subscriptionSchema.methods.cancelSubscription = function(reason = 'User cancelled') {
  this.isActive = false;
  this.cancellationDate = new Date();
  this.cancellationReason = reason;
};

// Enhanced method to check if subscription is likely valid with recency analysis
subscriptionSchema.methods.isLikelyValid = function() {
  // Check recency - subscriptions older than 6 months are questionable
  const daysSinceLastPayment = this.lastPaymentDate 
    ? Math.floor((new Date() - this.lastPaymentDate) / (1000 * 60 * 60 * 24))
    : 999;
  
  // Very old subscriptions are likely inactive
  if (daysSinceLastPayment > 180) {
    return false;
  }
  
  // High confidence if multiple consistent payments and recent
  if (this.paymentCount > 1 && this.isRecurring && daysSinceLastPayment <= 90) {
    return true;
  }
  
  // Medium confidence if single recent payment with high confidence score
  if (this.paymentCount === 1 && this.confidenceScore >= 6 && daysSinceLastPayment <= 60) {
    return true;
  }
  
  // Very recent payments with decent confidence
  if (daysSinceLastPayment <= 30 && this.confidenceScore >= 4) {
    return true;
  }
  
  return false;
};

// Method to analyze payment consistency
subscriptionSchema.methods.analyzePaymentConsistency = function() {
  if (this.paymentHistory.length < 2) {
    return {
      isConsistent: false,
      averageInterval: 0,
      hasMonthlyPattern: false
    };
  }
  
  // Sort payments by date
  const sortedPayments = this.paymentHistory.sort((a, b) => new Date(a.date) - new Date(b.date));
  
  // Calculate intervals between payments
  const intervals = [];
  for (let i = 1; i < sortedPayments.length; i++) {
    const intervalDays = (new Date(sortedPayments[i].date) - new Date(sortedPayments[i-1].date)) / (1000 * 60 * 60 * 24);
    intervals.push(intervalDays);
  }
  
  const averageInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const hasMonthlyPattern = averageInterval >= 25 && averageInterval <= 35;
  
  // Check amount consistency
  const amounts = sortedPayments.map(p => p.amount);
  const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const isConsistent = amounts.every(amount => Math.abs(amount - avgAmount) <= (avgAmount * 0.1));
  
  return {
    isConsistent,
    averageInterval,
    hasMonthlyPattern,
    paymentCount: this.paymentHistory.length
  };
};

subscriptionSchema.pre('save', function(next) {
  // Always calculate nextRenewal if it's not set or if renewalDay is modified
  if (!this.nextRenewal || this.isModified('renewalDay') || this.isNew) {
    this.nextRenewal = this.calculateNextRenewal();
  }
  
  // Don't calculate next renewal if cancelled
  if (this.cancellationDate) {
    this.nextRenewal = null;
  }
  
  next();
});

// Index for efficient queries
subscriptionSchema.index({ userId: 1, serviceName: 1 });
subscriptionSchema.index({ userId: 1, isActive: 1 });
subscriptionSchema.index({ nextRenewal: 1, isActive: 1 });

module.exports = mongoose.model('Subscription', subscriptionSchema);