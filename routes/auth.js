// routes/auth.js - JWT Authentication & Store Admin / Sales Manager Verification (Module 10)
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const {
  seedDefaultUsers,
  findUserByEmail,
  findUserById,
  createUser,
  verifyPassword,
  getAllUsers,
  getPendingSalesManagers,
  approveSalesManager,
  rejectSalesManager,
  disableSalesManager
} = require('../services/userStore');
const { verifyToken, requireStoreAdmin, JWT_SECRET } = require('../middleware/auth');
const notificationService = require('../services/notificationService');
const storeSyncService = require('../services/storeSyncService');

// Allowed retail store configurations (Module 10 requirement)
const VALID_STORES = [
  { code: 'STORE-01', name: 'Star Store 01' },
  { code: 'STORE-02', name: 'Star Store 02' },
  { code: 'STORE-03', name: 'Star Store 03' },
];

// Helper to sign JWT token - minimal claims only, NO sensitive details or passwords
function generateToken(user) {
  const userId = user.id || user._id;
  return jwt.sign(
    {
      id: String(userId),
      role: user.role,
      storeCode: user.storeCode,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Format safe user payload (omit password and sensitive details)
function sanitizeUser(user) {
  return {
    id: String(user.id || user._id),
    _id: String(user.id || user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    storeCode: user.storeCode,
    storeName: user.storeName,
    approvedAt: user.approvedAt || null,
    approvedBy: user.approvedBy || null,
    rejectedAt: user.rejectedAt || null,
    rejectedBy: user.rejectedBy || null,
    rejectionReason: user.rejectionReason || '',
    disabledAt: user.disabledAt || null,
    disabledBy: user.disabledBy || null,
    createdAt: user.createdAt
  };
}

// Rate limiting map: ip -> { count, resetTime }
const rateLimitMap = new Map();
function authRateLimiter(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || '127.0.0.1';
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxAttempts = 60; // 60 requests per minute

  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    entry = { count: 1, resetTime: now + windowMs };
    rateLimitMap.set(ip, entry);
    return next();
  }

  entry.count++;
  if (entry.count > maxAttempts) {
    const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      success: false,
      error: 'Too many authentication attempts. Please try again later.',
      retryAfter
    });
  }

  next();
}

// ---------------- PUBLIC AUTH ENDPOINTS ----------------

/**
 * POST /api/auth/register & /api/auth/register-manager
 * Sales Manager Signup ONLY.
 * Requirement A & B:
 * - Public Owner signup is strictly removed and rejected.
 * - Always creates Sales Manager with Pending Approval status.
 * - Never issues JWT cookie or authenticated session.
 */
router.post('/register', authRateLimiter, handleManagerSignup);
router.post('/register-manager', authRateLimiter, handleManagerSignup);

async function handleManagerSignup(req, res) {
  try {
    await seedDefaultUsers();
    const {
      name,
      email,
      password,
      confirmPassword,
      role,
      storeCode,
    } = req.body;

    // A. Owner account creation via public registration is strictly forbidden
    if (role === 'store_admin' || role === 'owner') {
      return res.status(403).json({
        success: false,
        error: 'Public registration of Owner / Store Admin accounts is strictly disabled. Please log in using configured credentials.'
      });
    }

    // Input validations
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Display name, email, and password are required.'
      });
    }

    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        error: 'Password and password confirmation do not match.'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters long.'
      });
    }

    // Validate store selection from the three existing configured stores
    const normalizedStoreCode = (storeCode || 'STORE-01').toUpperCase().trim();
    const matchedStore = VALID_STORES.find(s => s.code === normalizedStoreCode) || VALID_STORES[0];

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await findUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Registration request could not be processed with the provided information. Please verify your details or contact your Store Owner.'
      });
    }

    // Create user - enforces role = sales_manager and status = pending
    const newUser = await createUser({
      name: name.trim(),
      email: normalizedEmail,
      password,
      role: 'sales_manager',
      storeCode: matchedStore.code,
      storeName: matchedStore.name
    });

    const safeUser = sanitizeUser(newUser);

    // Notify connected Owner dashboards in real time via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('sales_manager_registered', {
        user: safeUser,
        timestamp: new Date()
      });
    }

    // Record non-blocking notification for Owner
    try {
      await notificationService.createNotification({
        idempotencyKey: `manager_signup:${safeUser.id}:${Date.now()}`,
        type: 'conversation_completed', // safe operational notice
        title: 'New Sales Manager Signup Request',
        description: `${safeUser.name} (${safeUser.email}) requested approval for ${matchedStore.name} (${matchedStore.code}).`,
        severity: 'info',
        storeCode: matchedStore.code,
      }, io);
    } catch (e) {
      // Non-blocking
    }

    // Return pending status without issuing token or setting cookie
    return res.status(201).json({
      success: true,
      status: 'pending',
      user: safeUser,
      message: 'Registration submitted successfully! Your Sales Manager account is pending approval by the Store Owner.'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/auth/login
 * Validates credentials, enforces approval status, and sets HttpOnly JWT cookie.
 */
router.post('/login', authRateLimiter, async (req, res) => {
  try {
    await seedDefaultUsers();
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required.'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await findUserByEmail(normalizedEmail);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password.'
      });
    }

    const isMatch = await verifyPassword(user, password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password.'
      });
    }

    // Status check for Sales Managers:
    // Only active, approved accounts may log in!
    if (user.role === 'sales_manager') {
      if (user.status === 'disabled') {
        return res.status(403).json({
          success: false,
          status: 'disabled',
          error: 'Your Sales Manager account has been disabled by the Store Owner. Access revoked.'
        });
      }

      if (user.status === 'pending') {
        return res.status(403).json({
          success: false,
          status: 'pending',
          error: 'Your Sales Manager account is pending approval by the Store Owner. Please wait for an administrator to approve your account before logging in.'
        });
      }

      if (user.status === 'rejected') {
        return res.status(403).json({
          success: false,
          status: 'rejected',
          error: `Your Sales Manager account registration was rejected by the Store Owner. ${user.rejectionReason ? `Reason: ${user.rejectionReason}` : ''}`
        });
      }

      // Re-verify store assignment exists
      if (!user.storeCode) {
        return res.status(403).json({
          success: false,
          error: 'Account has no authorized store assignment. Please contact Store Owner.'
        });
      }
    }

    // Generate JWT token (minimal claims only)
    const token = generateToken(user);
    const safeUser = sanitizeUser(user);

    // Determine if running under HTTPS or production environment
    const isProduction = process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https';

    // Set secure HttpOnly cookie (sameSite: 'none' and secure: true required for cross-domain Vercel deployment)
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
    });

    // Return authenticated user profile (JWT is stored exclusively in secure HttpOnly cookie)
    return res.json({
      success: true,
      user: safeUser,
      message: `Welcome back, ${user.name}!`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/auth/logout
 * Clears the HttpOnly JWT session cookie
 */
router.post('/logout', (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.clearCookie('token', {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  });
  return res.json({
    success: true,
    message: 'Signed out successfully. Session cookie cleared.'
  });
});

// ---------------- PROTECTED ENDPOINTS ----------------

/**
 * GET /api/auth/me
 * Returns current authenticated user profile
 */
router.get('/me', verifyToken, async (req, res) => {
  return res.json({
    success: true,
    user: sanitizeUser(req.user)
  });
});

/**
 * GET /api/auth/pending-sales-managers
 * Store Owner only: View all pending manager requests
 */
router.get('/pending-sales-managers', verifyToken, requireStoreAdmin, async (req, res) => {
  try {
    const pending = await getPendingSalesManagers();
    const safePending = pending.map(sanitizeUser);
    return res.json({
      success: true,
      count: safePending.length,
      users: safePending
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/auth/managers
 * Store Owner only: View all managers across all statuses (pending, approved, rejected, disabled)
 */
router.get('/managers', verifyToken, requireStoreAdmin, async (req, res) => {
  try {
    const all = await getAllUsers();
    const managers = all.filter(u => u.role === 'sales_manager').map(sanitizeUser);
    return res.json({
      success: true,
      count: managers.length,
      managers
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/auth/users
 * Store Owner only: View all users
 */
router.get('/users', verifyToken, requireStoreAdmin, async (req, res) => {
  try {
    const all = await getAllUsers();
    const safeUsers = all.map(sanitizeUser);
    return res.json({
      success: true,
      count: safeUsers.length,
      users: safeUsers
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/auth/users/:id/approve
 * Store Owner only: Approve a Sales Manager registration request
 */
router.post('/users/:id/approve', verifyToken, requireStoreAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const adminName = req.user.name || 'Store Owner';
    const updatedUser = await approveSalesManager(id, adminName);

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        error: 'Sales Manager user not found.'
      });
    }

    const safeUser = sanitizeUser(updatedUser);

    // Broadcast live event via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('sales_manager_status_changed', {
        userId: safeUser.id,
        email: safeUser.email,
        status: 'approved',
        approvedBy: adminName,
        timestamp: new Date()
      });
    }

    // Create system notification for Owner
    try {
      await notificationService.createNotification({
        idempotencyKey: `manager_approved:${safeUser.id}:${Date.now()}`,
        type: 'conversation_completed',
        title: 'Sales Manager Approved',
        description: `${safeUser.name} (${safeUser.email}) was approved for ${safeUser.storeName} (${safeUser.storeCode}).`,
        severity: 'success',
        storeCode: safeUser.storeCode,
      }, io);
    } catch (e) {
      // Non-blocking
    }

    return res.json({
      success: true,
      message: `Sales Manager ${safeUser.name} (${safeUser.email}) has been approved! They can now log in to ${safeUser.storeName}.`,
      user: safeUser
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/auth/users/:id/reject
 * Store Owner only: Reject a Sales Manager verification request
 */
router.post('/users/:id/reject', verifyToken, requireStoreAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = 'Verification declined by Store Owner' } = req.body;
    const adminName = req.user.name || 'Store Owner';
    const updatedUser = await rejectSalesManager(id, reason, adminName);

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        error: 'Sales Manager user not found.'
      });
    }

    const safeUser = sanitizeUser(updatedUser);

    // Broadcast live event
    const io = req.app.get('io');
    if (io) {
      io.emit('sales_manager_status_changed', {
        userId: safeUser.id,
        email: safeUser.email,
        status: 'rejected',
        reason,
        rejectedBy: adminName,
        timestamp: new Date()
      });
    }

    return res.json({
      success: true,
      message: `Sales Manager ${safeUser.name} registration was rejected.`,
      user: safeUser
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/auth/users/:id/disable
 * Store Owner only: Disable an active Sales Manager and revoke access
 */
router.post('/users/:id/disable', verifyToken, requireStoreAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const adminName = req.user.name || 'Store Owner';
    const updatedUser = await disableSalesManager(id, adminName);

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        error: 'Sales Manager user not found.'
      });
    }

    const safeUser = sanitizeUser(updatedUser);

    // Broadcast live event to force session termination
    const io = req.app.get('io');
    if (io) {
      io.emit('sales_manager_status_changed', {
        userId: safeUser.id,
        email: safeUser.email,
        status: 'disabled',
        disabledBy: adminName,
        timestamp: new Date()
      });

      // Revoke any active connected sockets for this user
      if (io.sockets && io.sockets.sockets) {
        for (const [sId, sock] of io.sockets.sockets.entries()) {
          const authUser = storeSyncService?.authenticatedSockets?.get(sId);
          if (authUser && String(authUser.id) === String(safeUser.id)) {
            sock.emit('session_revoked', { reason: 'Account disabled by Store Owner' });
            sock.disconnect(true);
            storeSyncService.authenticatedSockets.delete(sId);
          }
        }
      }
    }

    return res.json({
      success: true,
      message: `Sales Manager ${safeUser.name} has been disabled. Future sessions revoked.`,
      user: safeUser
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = {
  router,
  seedDefaultUsers,
  generateToken,
  sanitizeUser
};
