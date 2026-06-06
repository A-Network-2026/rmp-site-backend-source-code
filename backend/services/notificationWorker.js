const db = require('../db');
const { normalizeLang, t } = require('../utils/i18n');

async function sendLocalizedPush(user) {
  const lang = normalizeLang(user.preferred_language || 'en');
  const body = t('success.session_claimed', lang);

  // Placeholder transport: integrate real FCM sender here.
  // This keeps worker-safe behavior in environments without firebase-admin.
  if (user.device_token) {
    console.log(`[Notify] queued push to user ${user.id} (${lang}): ${body}`);
  }

  return true;
}

async function processExpiredSessions(limit = 200) {
  const rows = await db.query(
    `SELECT id, device_token, preferred_language
     FROM users
     WHERE session_end_time IS NOT NULL
       AND session_end_time <= NOW()
       AND COALESCE(notification_sent, FALSE) = FALSE
       AND COALESCE(is_deleted, FALSE) = FALSE
     ORDER BY session_end_time ASC
     LIMIT $1`,
    [limit]
  );

  let processed = 0;
  for (const user of rows.rows) {
    await sendLocalizedPush(user);
    await db.query(
      `UPDATE users
       SET notification_sent = TRUE
       WHERE id = $1`,
      [user.id]
    );
    processed += 1;
  }

  return { processed };
}

async function triggerNotificationFallback(userId) {
  const rowRes = await db.query(
    `SELECT id, session_end_time, notification_sent, device_token, preferred_language
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );

  const user = rowRes.rows[0];
  if (!user) {
    return { processed: false };
  }

  if (!user.session_end_time || new Date(user.session_end_time) > new Date() || user.notification_sent) {
    return { processed: false };
  }

  await sendLocalizedPush(user);
  await db.query('UPDATE users SET notification_sent = TRUE WHERE id = $1', [userId]);
  return { processed: true };
}

function startNotificationWorker(intervalMs = 60000) {
  const timer = setInterval(async () => {
    try {
      const summary = await processExpiredSessions();
      if (summary.processed > 0) {
        console.log(`[Notify] processed ${summary.processed} session notifications`);
      }
    } catch (err) {
      console.error('[Notify] worker error:', err.message || err);
    }
  }, intervalMs);

  return timer;
}

module.exports = {
  startNotificationWorker,
  processExpiredSessions,
  triggerNotificationFallback,
};
