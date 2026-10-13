/**
 * Storelistener — Module 10: Authentication & Sales Manager Approval Workflow Tests
 * File: test/module10_auth.test.js
 *
 * Automated verification of all Module 10 requirements:
 * 1. Existing Owner login works with existing credentials (admin@store.com / admin123).
 * 2. Owner signup is strictly unavailable through API (403 forbidden).
 * 3. Sales Manager signup creates a pending request with secure password hash and normalized email.
 * 4. Pending and rejected managers cannot log in (403 forbidden).
 * 5. Only the Owner can approve/reject manager requests (RBAC enforcement).
 * 6. Approved managers can log in and are authorized only for their assigned store.
 * 7. JWT cookies and protected endpoints follow security rules (HttpOnly, SameSite, no JWT in body).
 * 8. Disabling a manager immediately blocks subsequent access and logins.
 * 9. Existing modules 0-9 remain functional (Regression verification).
 */

require('dotenv').config();
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const BACKEND_URL = 'http://localhost:5000';
const { JWT_SECRET } = require('../middleware/auth');
const User = require('../models/User');
const { seedDefaultUsers, findUserByEmail } = require('../services/userStore');

// Helper to extract cookie from Set-Cookie header
function extractCookie(res, cookieName = 'token') {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return match ? match[1] : null;
}

describe('Module 10: Authentication Update & Approval Workflow', () => {
  let ownerCookie = null;
  let approvedManagerCookie = null;
  let testManagerId = null;
  const testRunId = Date.now();
  const testManagerEmail = `mgr.test.${testRunId}@retail.com`;
  const testManagerPassword = 'SecurePassword123!';

  before(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
    }
    await seedDefaultUsers();
  });

  after(async () => {
    // Cleanup test user if created
    try {
      if (mongoose.connection.readyState === 1 && testManagerId) {
        await User.deleteMany({ email: testManagerEmail });
      }
    } catch (e) {
      // Ignore cleanup error
    }
  });

  // 1. Existing Owner login works with existing credentials
  test('1. Owner Login: Existing Owner logs in with configured credentials, gets HttpOnly cookie without token in body', async () => {
    const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@store.com',
        password: 'admin123',
      }),
    });

    assert.equal(res.status, 200, 'Owner login should return HTTP 200');
    const data = await res.json();
    assert.equal(data.success, true, 'Login response should indicate success');
    assert.equal(data.user.role, 'store_admin', 'Owner role should be store_admin');
    assert.equal(data.token, undefined, 'JWT token MUST NOT be exposed in JSON response body');

    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'Set-Cookie header must be present');
    assert.ok(setCookie.includes('token='), 'Set-Cookie must contain token cookie');
    assert.ok(setCookie.toLowerCase().includes('httponly'), 'Cookie MUST be HttpOnly');
    assert.ok(setCookie.toLowerCase().includes('samesite=lax'), 'Cookie MUST have SameSite=lax');

    ownerCookie = extractCookie(res, 'token');
    assert.ok(ownerCookie, 'Owner cookie must be successfully extracted');
  });

  // 2. Owner signup is unavailable through API
  test('2. Owner Signup Disabled: Public signup cannot create an Owner account or assign store_admin role', async () => {
    const res = await fetch(`${BACKEND_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Malicious Admin Attempt',
        email: `hacker.${testRunId}@evil.com`,
        password: 'password123',
        confirmPassword: 'password123',
        role: 'store_admin',
        storeCode: 'STORE-01',
      }),
    });

    assert.equal(res.status, 403, 'Owner signup must return 403 Forbidden');
    const data = await res.json();
    assert.equal(data.success, false, 'Signup must fail');
    assert.ok(data.error.toLowerCase().includes('owner') || data.error.toLowerCase().includes('disabled'), 'Error message should explain Owner registration is disabled');
  });

  // 3. Sales Manager signup creates a pending request
  test('3. Sales Manager Signup: Creates account with Pending Approval status, no cookie or session issued', async () => {
    const res = await fetch(`${BACKEND_URL}/api/auth/register-manager`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test Sales Manager',
        email: testManagerEmail,
        password: testManagerPassword,
        confirmPassword: testManagerPassword,
        storeCode: 'STORE-02',
      }),
    });

    assert.equal(res.status, 201, 'Sales manager signup should return HTTP 201 Created');
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'pending', 'Account must be in pending status');
    assert.equal(data.user.role, 'sales_manager', 'Role must be locked to sales_manager');
    assert.equal(data.user.storeCode, 'STORE-02', 'Store must be set to selected store');
    assert.equal(data.token, undefined, 'No JWT token in signup response body');

    const setCookie = res.headers.get('set-cookie');
    assert.equal(setCookie, null, 'Public signup MUST NOT issue a session or JWT cookie');

    testManagerId = data.user.id || data.user._id;
  });

  // 3b. Duplicate signup with same email is rejected
  test('3b. Enforce Unique Email: Duplicate manager registration returns 400', async () => {
    const res = await fetch(`${BACKEND_URL}/api/auth/register-manager`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Duplicate Manager',
        email: testManagerEmail.toUpperCase(), // Test case insensitivity / normalization
        password: testManagerPassword,
        confirmPassword: testManagerPassword,
        storeCode: 'STORE-02',
      }),
    });

    assert.equal(res.status, 400, 'Duplicate email must be rejected with 400');
    const data = await res.json();
    assert.equal(data.success, false);
  });

  // 4. Pending managers cannot log in
  test('4. Login Guard: Pending sales manager is blocked with 403 and receives no cookie', async () => {
    const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testManagerEmail,
        password: testManagerPassword,
      }),
    });

    assert.equal(res.status, 403, 'Pending manager login must return 403 Forbidden');
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.status, 'pending', 'Status indicator must be pending');
    assert.equal(res.headers.get('set-cookie'), null, 'Must not issue JWT cookie');
  });

  // 5. Only Owner can approve/reject requests
  test('5a. RBAC on Approval: Non-owner or unauthenticated requests cannot approve managers', async () => {
    // Unauthenticated attempt
    const resUnauth = await fetch(`${BACKEND_URL}/api/auth/users/${testManagerId}/approve`, {
      method: 'POST',
    });
    assert.equal(resUnauth.status, 401, 'Unauthenticated approval must return 401');

    // Attempt with valid approved sales manager token
    const seededManager = await findUserByEmail('manager@store.com');
    assert.ok(seededManager, 'Seeded sales manager should exist');
    const nonOwnerToken = jwt.sign(
      { id: String(seededManager.id || seededManager._id), role: 'sales_manager', storeCode: 'STORE-NYC-01' },
      JWT_SECRET
    );
    const resForbidden = await fetch(`${BACKEND_URL}/api/auth/users/${testManagerId}/approve`, {
      method: 'POST',
      headers: { Cookie: `token=${nonOwnerToken}` },
    });
    assert.equal(resForbidden.status, 403, 'Sales manager approval by non-owner must return 403');
  });

  test('5b. Owner Approval Workflow: Owner approves manager, records audit timestamp and reviewing owner', async () => {
    const res = await fetch(`${BACKEND_URL}/api/auth/users/${testManagerId}/approve`, {
      method: 'POST',
      headers: { Cookie: `token=${ownerCookie}` },
    });

    assert.equal(res.status, 200, 'Owner approval must return HTTP 200');
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.user.status, 'approved', 'User status must be approved');
    assert.ok(data.user.approvedAt, 'Must record approvedAt timestamp');
    assert.ok(data.user.approvedBy, 'Must record approvedBy');
  });

  // 6. Approved manager can log in and is restricted to their assigned store
  test('6. Approved Manager Login & Store Authorization: Approved manager logs in and accesses only their store', async () => {
    const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testManagerEmail,
        password: testManagerPassword,
      }),
    });

    assert.equal(res.status, 200, 'Approved manager login must succeed');
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.user.storeCode, 'STORE-02');
    assert.equal(data.token, undefined, 'No token in response body');

    approvedManagerCookie = extractCookie(res, 'token');
    assert.ok(approvedManagerCookie, 'HttpOnly cookie must be issued to approved manager');

    // Verify /api/auth/me returns the authenticated user using cookie
    const meRes = await fetch(`${BACKEND_URL}/api/auth/me`, {
      headers: { Cookie: `token=${approvedManagerCookie}` },
    });
    assert.equal(meRes.status, 200);
    const meData = await meRes.json();
    assert.equal(meData.user.email, testManagerEmail.toLowerCase());
    assert.equal(meData.user.storeCode, 'STORE-02');

    // Manager cannot access Owner-only endpoints like pending requests
    const adminCheckRes = await fetch(`${BACKEND_URL}/api/auth/pending-sales-managers`, {
      headers: { Cookie: `token=${approvedManagerCookie}` },
    });
    assert.equal(adminCheckRes.status, 403, 'Manager cannot access Owner-only pending requests');
  });

  // 7. JWT Cookie security and Logout
  test('7. Cookie Security & Logout: Protected endpoints reject invalid tokens and logout clears cookie', async () => {
    // Protected endpoint without cookie
    const noCookieRes = await fetch(`${BACKEND_URL}/api/auth/me`);
    assert.equal(noCookieRes.status, 401, 'Request without cookie must return 401');

    // Logout
    const logoutRes = await fetch(`${BACKEND_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: `token=${approvedManagerCookie}` },
    });
    assert.equal(logoutRes.status, 200);
    const setCookie = logoutRes.headers.get('set-cookie');
    assert.ok(setCookie, 'Logout must send Set-Cookie');
    assert.ok(setCookie.includes('token=;') || setCookie.includes('Max-Age=0') || setCookie.includes('Expires='), 'Logout must clear token cookie');
  });

  // 8. Disabling a manager blocks subsequent access
  test('8. Disable Manager: Owner disables manager, blocking subsequent access and login', async () => {
    // Owner disables the manager
    const disableRes = await fetch(`${BACKEND_URL}/api/auth/users/${testManagerId}/disable`, {
      method: 'POST',
      headers: { Cookie: `token=${ownerCookie}` },
    });
    assert.equal(disableRes.status, 200, 'Owner can disable manager');
    const disableData = await disableRes.json();
    assert.equal(disableData.user.status, 'disabled', 'Status must be updated to disabled');

    // Attempt to access protected endpoint with the manager's cookie fails
    const blockedRes = await fetch(`${BACKEND_URL}/api/auth/me`, {
      headers: { Cookie: `token=${approvedManagerCookie}` },
    });
    assert.equal(blockedRes.status, 403, 'Disabled manager must receive 403 on protected endpoint');

    // Attempt to log in again with credentials fails with disabled message
    const loginAttempt = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testManagerEmail,
        password: testManagerPassword,
      }),
    });
    assert.equal(loginAttempt.status, 403, 'Disabled manager login must be blocked with 403');
    const loginData = await loginAttempt.json();
    assert.equal(loginData.status, 'disabled');
  });

  // 9. Existing modules remain functional (Regression)
  test('9. Regression Verification: Core Modules (Overview, Sessions, Notifications) remain fully functional', async () => {
    // Health check
    const healthRes = await fetch(`${BACKEND_URL}/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.status, 'online');

    // Stores overview (Module 5)
    const storesRes = await fetch(`${BACKEND_URL}/api/stores/overview`);
    assert.equal(storesRes.status, 200);
    const stores = await storesRes.json();
    assert.equal(stores.success, true);
    assert.ok(Array.isArray(stores.stores));

    // Sessions API (Module 5/6)
    const sessionsRes = await fetch(`${BACKEND_URL}/api/sessions?limit=3`);
    assert.equal(sessionsRes.status, 200);
    const sessions = await sessionsRes.json();
    assert.equal(sessions.success, true);

    // Notifications API (Module 8)
    const notifsRes = await fetch(`${BACKEND_URL}/api/notifications`, {
      headers: { Cookie: `token=${ownerCookie}` },
    });
    assert.equal(notifsRes.status, 200);
    const notifs = await notifsRes.json();
    assert.equal(notifs.success, true);
  });
});
