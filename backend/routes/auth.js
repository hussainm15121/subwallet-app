const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const auth = require('../middleware/auth');

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  console.log('🔄 Registration attempt started');
  console.log('📨 Request body:', { 
    email: req.body?.email, 
    name: req.body?.name, 
    hasPassword: !!req.body?.password 
  });
  
  try {
    const { email, password, name } = req.body;

    // Validate required fields
    if (!email || !password || !name) {
      console.log('❌ Missing required fields');
      return res.status(400).json({ message: 'Email, password, and name are required' });
    }

    console.log('✅ Required fields provided');

    // Check if user already exists
    console.log('🔍 Checking if user exists...');
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.log('❌ User already exists');
      return res.status(400).json({ message: 'User already exists' });
    }

    console.log('✅ User does not exist, creating new user...');

    // Create new user
    const user = new User({ email, password, name });
    await user.save();

    console.log('✅ User created successfully:', user._id);

    // Generate token
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '7d' }
    );

    console.log('✅ JWT token generated');

    res.status(201).json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        preferences: user.preferences,
        gmailAccounts: user.gmailAccounts || [],
        isGmailConnected: user.isGmailConnected || user.gmailAccounts?.length > 0
      }
    });

    console.log('✅ Registration successful for:', email);
  } catch (error) {
    console.error('❌ Registration error:', error);
    console.error('Error details:', error.message);
    res.status(500).json({ message: 'Registration failed', error: error.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Generate token
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        preferences: user.preferences,
        gmailAccounts: user.gmailAccounts || [],
        isGmailConnected: user.isGmailConnected || user.gmailAccounts?.length > 0
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Login failed', error: error.message });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  try {
    const user = req.user;
    
    // Migration: Ensure gmailAccounts field exists for backward compatibility
    if (!user.gmailAccounts) {
      user.gmailAccounts = [];
      await user.save();
    }
    
    res.json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        preferences: user.preferences,
        gmailAccounts: user.gmailAccounts || [],
        isGmailConnected: user.isGmailConnected || user.gmailAccounts?.length > 0
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to get user info' });
  }
});

// Update user preferences
router.put('/preferences', auth, async (req, res) => {
  try {
    const { currency, notifications } = req.body;
    
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { 
        'preferences.currency': currency,
        'preferences.notifications': notifications
      },
      { new: true }
    ).select('-password');

    res.json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        preferences: user.preferences,
        gmailAccounts: user.gmailAccounts || [],
        isGmailConnected: user.isGmailConnected || user.gmailAccounts?.length > 0
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update preferences' });
  }
});

// Update user profile
router.put('/profile', auth, async (req, res) => {
  try {
    const { name, avatar } = req.body;
    
    // Validate input
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ message: 'Name is required' });
    }
    
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { 
        name: name.trim(),
        avatar: avatar || ''
      },
      { new: true }
    ).select('-password');

    res.json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        preferences: user.preferences,
        gmailAccounts: user.gmailAccounts || [],
        isGmailConnected: user.isGmailConnected || user.gmailAccounts?.length > 0
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update profile' });
  }
});

// Get user settings
router.get('/settings', auth, async (req, res) => {
  try {
    const user = req.user;
    
    // Return user settings with defaults
    const settings = {
      currency: user.preferences?.currency || 'USD',
      notifications: user.preferences?.notifications || {
        email: true,
        push: true,
        renewalReminders: true,
        weeklyReports: false
      },
      privacy: user.preferences?.privacy || {
        shareUsageData: false,
        marketingEmails: false
      },
      display: user.preferences?.display || {
        theme: 'light',
        dateFormat: 'MM/DD/YYYY',
        compactView: false
      }
    };

    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: 'Failed to get settings' });
  }
});

// Update user settings
router.put('/settings', auth, async (req, res) => {
  try {
    const { currency, notifications, privacy, display } = req.body;
    
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { 
        'preferences.currency': currency,
        'preferences.notifications': notifications,
        'preferences.privacy': privacy,
        'preferences.display': display
      },
      { new: true }
    ).select('-password');

    res.json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        preferences: user.preferences,
        gmailAccounts: user.gmailAccounts || [],
        isGmailConnected: user.isGmailConnected || user.gmailAccounts?.length > 0
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update settings' });
  }
});

// Delete user account
router.delete('/account', auth, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.user._id);
    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete account' });
  }
});

module.exports = router;