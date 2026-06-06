# 🪙 A-NETWORK ANET WALLET & ECOSYSTEM IMPLEMENTATION
## Comprehensive System Update for Custom ANET Wallets & 30-Day Inactivity Rules

---

## 📋 OVERVIEW

This implementation introduces a complete wallet ecosystem overhaul for A-Network, focusing on:
- **ANET Custom Wallets** - Secure server-side wallet generation with unique `ANET***...***` address format
- **ANT Token System** - All mining rewards now credited as ANT tokens to dedicated ANET wallets
- **EVM Integration** - Optional MetaMask/EVM wallet connection for multi-chain support
- **30-Day Inactivity Rule** - Automatic cleanup and ecological coin return for inactive accounts
- **Transaction Tracking** - Comprehensive ANT transaction ledger for security and transparency

---

## 🔄 SYSTEM ARCHITECTURE

### Database Schema Changes

**New User Fields:**
```sql
custom_wallet_address VARCHAR(255) UNIQUE     -- ANET****... format wallet
evm_connected_address VARCHAR(42)             -- Optional MetaMask connection
ant_balance DECIMAL(20, 8) DEFAULT 0          -- ANT token holdings
last_activity_at TIMESTAMP                    -- Inactivity tracking
is_deleted BOOLEAN DEFAULT FALSE              -- Soft delete for cleanup
deleted_at TIMESTAMP                          -- Deletion timestamp
```

**New Tables:**
- `ant_transactions` - Tracks all ANT token movements
  - `transaction_type` (mining_reward, ecosystem_return, evm_bridge, wallet_created, referral_bonus)
  - `amount, from_address, to_address, description, status`

### Indexes:
- `idx_last_activity` - For inactivity queries
- `idx_is_deleted` - For cleanup operations
- `idx_custom_wallet` - For wallet lookups
- `idx_transaction_type` - For transaction analysis

---

## 🪙 ANET WALLET SYSTEM

### Wallet Address Format
```
ANET + 40 Random Alphanumeric Characters = 44 characters total
Example: ANETX82KJ9QW5P3MM8B1C6DV4RT7EF9GH2J3K4L5M
```

### Key Characteristics
✓ **Server-Secured** - Generated and stored server-side, not exposed as seed phrases
✓ **Unique per User** - Each user gets exactly one ANET wallet
✓ **Immutable** - Cannot be changed or deleted
✓ **Permanent** - Saved to user profile and ready for Layer 1 migration
✓ **Non-EVM** - Separate from blockchain wallets (EVM-compatible wallets are optional)

### Wallet Lifecycle
1. **Creation** - Auto-triggered on first login after wallet requirement is enforced
2. **Activation** - Becomes active when user starts mining
3. **Population** - Receives ANT rewards from completed mining sessions
4. **Layer 1 Migration** - Ready for future blockchain integration

---

## 🏦 ANT TOKEN & TRANSACTION SYSTEM

### ANT Token Overview
```
- Token Name: ANT (A-Network Token)
- Decimals: 8 (like Bitcoin)
- Source: Mining rewards only
- Destination: ANET custom wallets exclusively
- Security: Tracked in centralized ledger before L2 deployment
```

### Mining Reward Flow
```
User Completes Mining Session (6 hours)
    ↓
calculateRate() - Gets reward amount based on halving level
    ↓
UPDATE users SET ant_balance = ant_balance + reward
    ↓
INSERT ant_transactions (mining_reward, amount, to_address)
    ↓
UPDATE network_stats SET total_mined = total_mined + reward
    ↓
User receives ANT in their ANET wallet
```

### Transaction Types
1. **mining_reward** - Standard mining session completion
2. **ecosystem_return** - Returned when account inactive 30 days
3. **evm_bridge** - Future EVM chain transfers
4. **wallet_created** - Initial wallet creation event
5. **referral_bonus** - Future referral rewards

---

## ⏰ 30-DAY INACTIVITY RULE

### Trigger Mechanism
```
IF user.last_activity_at < (NOW - 30 DAYS)
   AND user.is_deleted = FALSE
   AND user.email_verified = TRUE
THEN cleanup()
```

### Cleanup Process
1. **Coin Return** - All ANT balance returned to ecosystem for redistribution
2. **Transaction Logged** - Recorded in ant_transactions as 'ecosystem_return'
3. **Network Update** - total_mined adjusted to reflect returned coins
4. **Account Soft Delete** - is_deleted = TRUE, user data preserved
5. **Email Notification** - User notified of cleanup (optional)

### Activity Tracked By
- Login
- Mining start
- Mining completion
- Profile checks
- Wallet operations
- Any API authentication

---

## 🔌 EVM WALLET INTEGRATION (Optional)

### Overview
Users can optionally connect EVM-compatible wallets (MetaMask, WalletConnect, etc.)
for future multi-chain functionality.

### Workflow
```
POST /auth/wallet/connect-evm
{
  "evmAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f42D4"
}

Response:
{
  "evmWallet": "0x742d35...",
  "message": "EVM wallet connected"
}
```

### Usage
- Prepare for Layer 1 migration
- Optional secondary wallet tracking
- Future bridge transactions
- Does NOT receive mining rewards directly (goes to ANET only)

---

## 🛠️ BACKEND IMPLEMENTATION

### New Files Created

#### 1. `/backend/utils/walletUtils.js`
```javascript
generateANETWalletAddress()     // Creates ANET****... addresses
isValidANETWallet(address)      // Format validation
isValidEVMAddress(address)      // EVM address validation
```

#### 2. `/backend/services/inactivityCleanup.js`
```javascript
cleanupInactiveAccounts()       // Runs daily at 24h intervals
getInactivityStats()            // Reports on inactive accounts
INACTIVITY_THRESHOLD_DAYS = 30
```

#### 3. `/backend/routes/cleanup.js`
Admin endpoints:
- `POST /cleanup/cleanup-inactive` - Manual trigger
- `GET /cleanup/inactivity-stats` - View statistics
- `GET /cleanup/ant-balance/:userId` - Balance check
- `GET /cleanup/ant-transactions/:userId` - Transaction history

### Updated Routes

#### Auth Routes (`/auth`)
```javascript
POST /auth/wallet/create              // Creates ANET wallet
GET /auth/wallet                      // Gets wallet info
POST /auth/wallet/connect-evm         // Connects EVM wallet
POST /auth/wallet/disconnect-evm      // Disconnects EVM wallet
GET /auth/me                          // Returns updated profile with wallets
```

**Response Format:**
```json
{
  "customWallet": "ANETxxx...",
  "evmWallet": "0x742d...",
  "antBalance": 123.45,
  "hasANETWallet": true
}
```

#### Mining Routes (`/mining`)
**Updated to:**
- Check for `custom_wallet_address` instead of `wallet_address`
- Update `ant_balance` alongside `balance`
- Track `last_activity_at` on session start and completion
- Log transactions to `ant_transactions` table
- Return `antBalance` in responses

### Scheduled Tasks

#### Inactivity Cleanup Job
```javascript
// Runs every 24 hours
setInterval(async () => {
  const result = await cleanupInactiveAccounts();
  console.log(`Cleaned ${result.cleanedUpCount} inactive accounts`);
}, 24 * 60 * 60 * 1000);

// Initial run after 1 minute startup delay
setTimeout(scheduleCleanup, 60000);
```

---

## 📱 FLUTTER APP CHANGES

### Updated Files

#### `lib/main.dart` - Wallet State Management
```dart
// OLD: wallet_address, wallet_passphrase, seed phrases
// NEW: custom_wallet_address, evm_connected_address, ANET format

String createdWalletAddress = 'Not created';        // ANET wallet
String createdSeedPhrase = 'Server-secured';        // No seed needed
```

#### Wallet Sync Function
```dart
Future<void> _syncWalletFromServer() async {
  final walletData = await getMyWalletAPI();
  final customWallet = walletData['customWallet'];
  final hasANETWallet = customWallet != null;
  // Updates UI with ANET wallet info
}
```

#### Wallet Creation UI
```dart
Future<void> createWallet() async {
  final result = await createWalletAPI();
  // Validates customWallet starts with ANET
  // Shows ANET-specific dialog
  // No seed phrase to save (server-secured)
}
```

**Updated Dialog Messages:**
- "Your exclusive ANET wallet has been created!"
- "✓ All mining rewards go to this wallet"
- "✓ Secure server-side generation"
- "✓ Ready for Layer 1 migration"

---

## 🔐 SECURITY MEASURES

### Wallet Protection
✓ Unique addresses per user (collision impossible)
✓ Server-side generation (seed phrases eliminated)
✓ No export/backup mechanism (prevents theft)
✓ Soft delete recovery (data preserved if needed)

### Inactivity Protection
✓ Coins returned to ecosystem (no lost funds)
✓ Configurable threshold (currently 30 days)
✓ Activity tracking on all operations
✓ Transparent transaction log

### Admin Controls
✓ Manual cleanup trigger (emergency)
✓ Inactivity statistics dashboard
✓ Transaction history audit trail
✓ Admin-only access (role-based)

---

## 📊 MIGRATION GUIDE

### For Existing Users
1. **Automatic Creation** - ANET wallets created on next login
2. **Backward Compatible** - Old wallet system still accessible during grace period
3. **Data Preservation** - All mining history and stakes preserved
4. **Transparent Flow** - Users see wallet creation prompt
5. **Optional EVM** - MetaMask connection optional, not required

### For New Users
1. **Immediate** - ANET wallet required before mining
2. **Simple** - One-click wallet creation
3. **Automatic** - No seed phrases to manage
4. **Ready** - Immediately start mining to ANET wallet

---

## 🚀 DEPLOYMENT CHECKLIST

### Pre-Deployment
- [ ] Database migration script tested
- [ ] Backup of current `users` table
- [ ] Review `INACTIVITY_THRESHOLD_DAYS = 30` (adjust if needed)
- [ ] Set `ADMIN_USER_IDS` in `.env` for cleanup endpoints

### Deployment
- [ ] Run database schema migration
- [ ] Deploy backend routes (auth, mining, cleanup)
- [ ] Deploy inactivity service and scheduler
- [ ] Update Flutter app (main.dart changes)
- [ ] Rebuild and release mobile apps

### Post-Deployment
- [ ] Monitor inactivity cleanup logs
- [ ] Verify ANT transactions are being recorded
- [ ] Check wallet creation success rate
- [ ] Confirm activity tracking on logins/mining
- [ ] Test admin cleanup endpoints

---

## 📈 MONITORING & ANALYTICS

### Key Metrics to Track
```
- Daily active users (DAU)
- Inactive users count (30+ days)
- ANT balance distribution
- Transaction volume and types
- Wallet creation success rate
- EVM connection adoption rate
```

### Cleanup Statistics
```
/cleanup/inactivity-stats returns:
{
  "inactivityThresholdDays": 30,
  "total_inactive_accounts": 1234,
  "total_ant_at_risk": 5678.90,
  "accounts_with_balance": 456
}
```

---

## 🔜 FUTURE ENHANCEMENTS

### Phase 2: Layer 1 Migration
- Deploy ANET smart contract on Layer 1
- Bridge ANET wallets to blockchain addresses
- Enable direct token transfers
- Implement on-chain governance

### Phase 3: Web3 Integration
- MetaMask integration for transactions
- Decentralized exchange listings
- Staking mechanisms
- Cross-chain bridges

### Phase 4: DeFi Ecosystem
- Lending protocols
- Yield farming
- Governance tokens
- DAO formation

---

## 📞 SUPPORT & TROUBLESHOOTING

### Common Issues

**Q: User's ANET wallet not showing?**
A: Check `custom_wallet_address` field exists. Run migration script.

**Q: Cleanup happening too early?**
A: Verify `last_activity_at` is being updated on all user actions.

**Q: ANT transactions not logging?**
A: Ensure `ant_transactions` table exists and user has `custom_wallet_address`.

### Admin Commands
```bash
# Manual cleanup trigger
curl -X POST http://localhost:3000/cleanup/cleanup-inactive \
  -H "Authorization: Bearer <ADMIN_TOKEN>"

# Check inactivity stats
curl http://localhost:3000/cleanup/inactivity-stats \
  -H "Authorization: Bearer <ADMIN_TOKEN>"

# View user balance and transactions
curl http://localhost:3000/cleanup/ant-balance/USER_ID \
  -H "Authorization: Bearer <TOKEN>"
```

---

## 📝 MISCELLANEOUS

### Environment Variables
```
ADMIN_USER_IDS=1,2,3          # Comma-separated admin user IDs
EMAIL_OTP_TTL_MINUTES=10       # OTP expiration
JWT_SECRET=your_secret_key     # JWT signing key
```

### Database Maintenance
```sql
-- Monitor inactive accounts
SELECT COUNT(*), SUM(ant_balance) 
FROM users 
WHERE last_activity_at < NOW() - INTERVAL '30 days'
  AND is_deleted = FALSE;

-- Check wallet distribution
SELECT COUNT(*), AVG(ant_balance), MAX(ant_balance)
FROM users
WHERE custom_wallet_address IS NOT NULL;

-- Cleanup history
SELECT COUNT(*), SUM(amount)
FROM ant_transactions
WHERE transaction_type = 'ecosystem_return'
  AND created_at > NOW() - INTERVAL '30 days';
```

---

## ✅ IMPLEMENTATION COMPLETE

All files have been updated. The system is ready for:
- ✓ ANET wallet creation and management
- ✓ ANT token tracking and transactions
- ✓ Automatic inactivity cleanup
- ✓ EVM wallet integration (optional)
- ✓ Comprehensive audit logging
- ✓ Admin dashboard support

**Status:** Ready for testing and deployment
