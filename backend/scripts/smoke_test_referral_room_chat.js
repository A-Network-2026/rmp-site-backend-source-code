require('dotenv').config();

const jwt = require('jsonwebtoken');
const db = require('../db');

const baseUrl = `http://127.0.0.1:${process.env.PORT || 3000}`;

function buildToken({ userId, deviceId, sessionNonce }) {
  return jwt.sign(
    {
      userId,
      deviceId,
      deviceFingerprint: null,
      sessionNonce,
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function callApi(path, { token, deviceId, method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'x-device-id': deviceId,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text };
  }

  return {
    status: response.status,
    data,
  };
}

(async () => {
  const stamp = Date.now();
  const ownerDevice = `test-owner-${stamp}`;
  const referralDevice = `test-ref-${stamp}`;
  const ownerNonce = `nonce-owner-${stamp}`;
  const referralNonce = `nonce-ref-${stamp}`;
  const ownerEmail = `chat_owner_${stamp}@example.com`;
  const referralEmail = `chat_ref_${stamp}@example.com`;
  let ownerId;
  let referralId;

  try {
    const health = await fetch(baseUrl);
    if (!health.ok) {
      throw new Error(`Backend not healthy: ${health.status}`);
    }

    const ownerRes = await db.query(
      `INSERT INTO users (email, password, device_id, session_nonce, referral_code)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, referral_code`,
      [ownerEmail, 'test-password', ownerDevice, ownerNonce, `TESTOWN${stamp}`]
    );
    ownerId = ownerRes.rows[0].id;

    const referralRes = await db.query(
      `INSERT INTO users (email, password, device_id, session_nonce, referred_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [referralEmail, 'test-password', referralDevice, referralNonce, ownerId]
    );
    referralId = referralRes.rows[0].id;

    const ownerToken = buildToken({
      userId: ownerId,
      deviceId: ownerDevice,
      sessionNonce: ownerNonce,
    });
    const referralToken = buildToken({
      userId: referralId,
      deviceId: referralDevice,
      sessionNonce: referralNonce,
    });

    const ownerInitial = await callApi('/auth/community-chat', {
      token: ownerToken,
      deviceId: ownerDevice,
    });
    if (ownerInitial.status !== 200 || ownerInitial.data.accessRole !== 'owner') {
      throw new Error(`Owner room load failed: ${JSON.stringify(ownerInitial)}`);
    }

    const rename = await callApi('/auth/community-chat/room-name', {
      token: ownerToken,
      deviceId: ownerDevice,
      method: 'POST',
      body: { roomName: 'Farmer Ants' },
    });
    if (rename.status !== 200 || rename.data.roomName !== 'Farmer Ants') {
      throw new Error(`Owner rename failed: ${JSON.stringify(rename)}`);
    }

    const invalidRename = await callApi('/auth/community-chat/room-name', {
      token: ownerToken,
      deviceId: ownerDevice,
      method: 'POST',
      body: { roomName: 'Random Group Name' },
    });
    if (invalidRename.status !== 400) {
      throw new Error(`Invalid rename should fail: ${JSON.stringify(invalidRename)}`);
    }

    const referralView = await callApi('/auth/community-chat', {
      token: referralToken,
      deviceId: referralDevice,
    });
    if (
      referralView.status !== 200 ||
      referralView.data.accessRole !== 'referral-member' ||
      referralView.data.roomName !== 'Farmer Ants' ||
      referralView.data.roomOwnerId !== ownerId
    ) {
      throw new Error(`Referral room load failed: ${JSON.stringify(referralView)}`);
    }

    const referralRename = await callApi('/auth/community-chat/room-name', {
      token: referralToken,
      deviceId: referralDevice,
      method: 'POST',
      body: { roomName: 'Scout Ants' },
    });
    if (referralRename.status !== 403) {
      throw new Error(`Referral rename should fail: ${JSON.stringify(referralRename)}`);
    }

    const ownerMessage = await callApi('/auth/community-chat', {
      token: ownerToken,
      deviceId: ownerDevice,
      method: 'POST',
      body: { message: 'owner smoke test message' },
    });
    if (ownerMessage.status !== 201) {
      throw new Error(`Owner message failed: ${JSON.stringify(ownerMessage)}`);
    }

    const referralMessage = await callApi('/auth/community-chat', {
      token: referralToken,
      deviceId: referralDevice,
      method: 'POST',
      body: { message: 'referral smoke test message' },
    });
    if (referralMessage.status !== 201) {
      throw new Error(`Referral message failed: ${JSON.stringify(referralMessage)}`);
    }

    const ownerFinal = await callApi('/auth/community-chat', {
      token: ownerToken,
      deviceId: ownerDevice,
    });
    if (
      ownerFinal.status !== 200 ||
      !Array.isArray(ownerFinal.data.messages) ||
      ownerFinal.data.messages.length < 2
    ) {
      throw new Error(`Final owner read failed: ${JSON.stringify(ownerFinal)}`);
    }

    const summary = {
      ok: true,
      ownerId,
      referralId,
      roomName: ownerFinal.data.roomName,
      roomOwnerId: ownerFinal.data.roomOwnerId,
      ownerRole: ownerFinal.data.accessRole,
      referralRole: referralView.data.accessRole,
      invalidRenameStatus: invalidRename.status,
      referralRenameStatus: referralRename.status,
      messageCount: ownerFinal.data.messages.length,
      lastMessages: ownerFinal.data.messages.slice(-2).map((item) => ({
        sender: item.senderLabel,
        text: item.text,
      })),
    };

    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('[smoke-test-failed]', error.message || error);
    process.exitCode = 1;
  } finally {
    try {
      if (referralId) {
        await db.query('DELETE FROM users WHERE id = $1', [referralId]);
      }
      if (ownerId) {
        await db.query('DELETE FROM users WHERE id = $1', [ownerId]);
      }
    } catch (cleanupError) {
      console.error('[cleanup-warning]', cleanupError.message || cleanupError);
      process.exitCode = process.exitCode || 1;
    }

    await db.end();
  }
})();
