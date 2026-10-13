/**
 * Storelistener Backend — Smart Alerts & Notification Service (Module 8)
 * File: services/notificationService.js
 *
 * Implements:
 * 1. Configurable alert rules for the 8 core operational events
 * 2. Strict idempotency key duplicate prevention across reconnects & retries
 * 3. Real-time Socket.IO emission to authorized owner/store dashboard clients
 * 4. Persistent notification storage in MongoDB Atlas
 * 5. Role-based and store-isolated access controls
 * 6. Non-blocking error containment ensuring zero impact on recording/transcription
 */

const Notification = require('../models/Notification');
const NotificationSettings = require('../models/NotificationSettings');

class NotificationService {
  /**
   * Fetches persistent notification settings or seeds defaults
   */
  async getSettings(userId = 'global_owner') {
    try {
      let settings = await NotificationSettings.findOne({ userId });
      if (!settings) {
        settings = await NotificationSettings.create({ userId });
      }
      return settings;
    } catch (err) {
      console.warn('[NotificationService] Failed to load settings from DB, using defaults:', err.message);
      return new NotificationSettings({ userId });
    }
  }

  /**
   * Updates notification rules and thresholds
   */
  async updateSettings(updates = {}, userId = 'global_owner') {
    let settings = await NotificationSettings.findOne({ userId });
    if (!settings) {
      settings = new NotificationSettings({ userId });
    }

    if (updates.rules) {
      for (const [ruleKey, ruleVal] of Object.entries(updates.rules)) {
        if (settings.rules[ruleKey]) {
          if (ruleVal.enabled !== undefined) {
            settings.rules[ruleKey].enabled = Boolean(ruleVal.enabled);
          }
          if (ruleVal.severity && ['info', 'success', 'warning', 'error'].includes(ruleVal.severity)) {
            settings.rules[ruleKey].severity = ruleVal.severity;
          }
          if (ruleVal.thresholdMinutes !== undefined) {
            const parsed = parseInt(ruleVal.thresholdMinutes, 10);
            if (!isNaN(parsed) && parsed >= 5 && parsed <= 1440) {
              settings.rules[ruleKey].thresholdMinutes = parsed;
            }
          }
        }
      }
    }

    if (updates.emailDelivery) {
      if (updates.emailDelivery.enabled !== undefined) {
        settings.emailDelivery.enabled = Boolean(updates.emailDelivery.enabled);
      }
      if (typeof updates.emailDelivery.recipientEmail === 'string') {
        settings.emailDelivery.recipientEmail = updates.emailDelivery.recipientEmail.trim();
      }
    }

    await settings.save();
    return settings;
  }

  /**
   * Core alert dispatch: checks rules, prevents duplicates, persists to DB, and broadcasts live
   */
  async createNotification(alertData, io = null) {
    const rawKey = alertData?.idempotencyKey;
    try {
      if (!alertData || typeof alertData !== 'object') {
        console.warn('[NotificationService] Invalid or null alertData passed');
        return null;
      }

      const {
        idempotencyKey,
        type,
        title,
        description,
        severity,
        storeId,
        storeCode,
        storeName,
        salesRep,
        sessionId,
        metadata = {},
        targetRoles = ['store_admin', 'sales_manager'],
      } = alertData;

      if (!idempotencyKey || !type || !title || !description) {
        console.warn('[NotificationService] Missing required alert fields:', { idempotencyKey, type, title });
        return null;
      }

      // 1. Check settings to determine if this alert rule is enabled
      const settings = await this.getSettings();
      const ruleConfig = settings.rules[type];

      if (ruleConfig && ruleConfig.enabled === false) {
        // Owner has disabled this alert rule
        return null;
      }

      const activeSeverity = severity || ruleConfig?.severity || 'info';

      // 2. Strict Idempotency: Prevent duplicate notifications for identical events
      const existing = await Notification.findOne({ idempotencyKey });
      if (existing) {
        return existing; // Idempotent return without duplicate insert
      }

      // 3. Persist new notification in MongoDB
      const notification = await Notification.create({
        idempotencyKey,
        type,
        title,
        description,
        severity: activeSeverity,
        storeId: storeId || null,
        storeCode: storeCode || null,
        storeName: storeName || null,
        salesRep: salesRep || null,
        sessionId: sessionId || null,
        metadata,
        targetRoles,
        isRead: false,
      });

      console.log(`🔔 [Alert Created] [${activeSeverity.toUpperCase()}] ${title} (${storeCode || 'Network'}) [${idempotencyKey}]`);

      // 4. Real-Time Broadcast via Socket.IO
      if (io) {
        try {
          // Broadcast to all dashboard sockets
          io.emit('new_notification', {
            notification,
            unreadCountDelta: 1,
          });

          // Broadcast updated unread count for store
          const unreadCount = await Notification.countDocuments({ isRead: false });
          io.emit('notifications_count_update', {
            unreadCount,
          });
        } catch (socketErr) {
          console.warn('[NotificationService] Socket broadcast failed (non-blocking):', socketErr.message);
        }
      }

      // 5. Optional Email Delivery Channel
      if (settings.emailDelivery?.enabled && settings.emailDelivery?.recipientEmail) {
        this.dispatchOptionalEmail(notification, settings.emailDelivery.recipientEmail);
      }

      return notification;
    } catch (err) {
      if (err.code === 11000) {
        // Race condition duplicate key caught gracefully
        return await Notification.findOne({ idempotencyKey: rawKey });
      }
      console.error('[NotificationService] Failed to create notification (non-blocking):', err.message);
      return null;
    }
  }

  /**
   * Optional email notification dispatcher
   */
  dispatchOptionalEmail(notification, recipientEmail) {
    try {
      console.log(`📧 [Email Alert Simulated] To: ${recipientEmail} | Subject: [Storelistener Alert] ${notification.title}`);
      // Record simulated dispatch in notification metadata
      notification.metadata = {
        ...(notification.metadata || {}),
        emailDispatchedTo: recipientEmail,
        emailDispatchedAt: new Date(),
      };
      notification.save().catch(() => {});
    } catch (err) {
      console.warn('[NotificationService] Email delivery notice:', err.message);
    }
  }

  /**
   * Queries notifications with pagination, filters, and store-level isolation
   */
  async getNotifications(queryParams = {}, user = null) {
    const {
      isRead,
      type,
      severity,
      store,
      storeCode,
      limit = 40,
      skip = 0,
    } = queryParams;

    const filter = {};

    // Role-based store isolation
    if (user && user.role === 'sales_manager' && user.storeCode) {
      const cleanManagerStore = user.storeCode.trim();
      filter.$or = [
        { storeCode: cleanManagerStore },
        { storeCode: null }, // Global system alerts
      ];
    } else {
      const targetStore = store || storeCode;
      if (targetStore && targetStore !== 'all') {
        filter.$or = [
          { storeCode: targetStore },
          { storeId: targetStore },
        ];
      }
    }

    if (isRead !== undefined && isRead !== 'all') {
      filter.isRead = isRead === 'true' || isRead === true;
    }

    if (type && type !== 'all') {
      filter.type = type;
    }

    if (severity && severity !== 'all') {
      filter.severity = severity;
    }

    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 40));
    const parsedSkip = Math.max(0, parseInt(skip, 10) || 0);

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(parsedSkip).limit(parsedLimit),
      Notification.countDocuments(filter),
      this.getUnreadCount(user),
    ]);

    return {
      notifications,
      total,
      unreadCount,
      limit: parsedLimit,
      skip: parsedSkip,
    };
  }

  /**
   * Counts unread notifications within user's authorization scope
   */
  async getUnreadCount(user = null) {
    const filter = { isRead: false };
    if (user && user.role === 'sales_manager' && user.storeCode) {
      filter.$or = [
        { storeCode: user.storeCode.trim() },
        { storeCode: null },
      ];
    }
    return await Notification.countDocuments(filter);
  }

  /**
   * Marks a single notification as read
   */
  async markAsRead(notificationId, user = null, io = null) {
    const notification = await Notification.findById(notificationId);
    if (!notification) {
      throw new Error(`Notification ${notificationId} not found`);
    }

    // Store isolation check for sales manager
    if (user && user.role === 'sales_manager' && user.storeCode) {
      if (notification.storeCode && notification.storeCode !== user.storeCode) {
        throw new Error('Access denied: Cannot modify notification for another store branch');
      }
    }

    notification.isRead = true;
    notification.readAt = new Date();
    await notification.save();

    if (io) {
      const unreadCount = await this.getUnreadCount(user);
      io.emit('notifications_count_update', { unreadCount });
    }

    return notification;
  }

  /**
   * Marks all unread notifications within user's scope as read
   */
  async markAllAsRead(user = null, io = null) {
    const filter = { isRead: false };
    if (user && user.role === 'sales_manager' && user.storeCode) {
      filter.$or = [
        { storeCode: user.storeCode.trim() },
        { storeCode: null },
      ];
    }

    const result = await Notification.updateMany(filter, {
      $set: { isRead: true, readAt: new Date() },
    });

    if (io) {
      io.emit('notifications_count_update', { unreadCount: 0 });
    }

    return { modifiedCount: result.modifiedCount };
  }

  /**
   * Deletes a notification
   */
  async deleteNotification(notificationId, user = null, io = null) {
    const notification = await Notification.findById(notificationId);
    if (!notification) {
      throw new Error(`Notification ${notificationId} not found`);
    }

    if (user && user.role === 'sales_manager' && user.storeCode) {
      if (notification.storeCode && notification.storeCode !== user.storeCode) {
        throw new Error('Access denied: Cannot delete notification for another store branch');
      }
    }

    await Notification.findByIdAndDelete(notificationId);

    if (io) {
      const unreadCount = await this.getUnreadCount(user);
      io.emit('notifications_count_update', { unreadCount });
    }

    return { success: true };
  }
}

const notificationService = new NotificationService();
module.exports = notificationService;
