// middleware/auth.js - JWT Authentication & Role-based Authorization Middleware
const jwt = require('jsonwebtoken');
const { findUserById } = require('../services/userStore');

const JWT_SECRET = process.env.JWT_SECRET || 'storelistener_jwt_secret_key_2026_enterprise_auth';

// Middleware to verify JWT token
async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const cookieToken = req.cookies?.token;
    let token = null;

    if (cookieToken) {
      token = cookieToken;
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. No authorization token or session cookie provided.'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired authorization session. Please sign in again.'
      });
    }

    const user = await findUserById(decoded.id);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User account associated with this session was not found.'
      });
    }

    // Role-specific approval checks:
    // Store Admin is always authorized.
    // Sales Manager MUST be approved by the Store Owner.
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
          error: 'Your Sales Manager account is pending approval by the Store Owner.'
        });
      }

      if (user.status === 'rejected') {
        return res.status(403).json({
          success: false,
          status: 'rejected',
          error: `Your Sales Manager account verification was rejected. Reason: ${user.rejectionReason || 'Contact Store Owner'}`
        });
      }
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Authentication middleware error: ' + err.message
    });
  }
}

// Middleware: Restrict access to Store Admin only
function requireStoreAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'store_admin') {
    return res.status(403).json({
      success: false,
      error: 'Access denied: Store Admin privileges required.'
    });
  }
  next();
}

// Middleware: Restrict access to Sales Manager only
function requireSalesManager(req, res, next) {
  if (!req.user || req.user.role !== 'sales_manager') {
    return res.status(403).json({
      success: false,
      error: 'Access denied: Sales Manager privileges required.'
    });
  }
  next();
}

module.exports = {
  verifyToken,
  requireStoreAdmin,
  requireSalesManager,
  JWT_SECRET
};
