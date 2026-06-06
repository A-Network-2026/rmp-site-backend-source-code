# ⚡ Quick Start Guide

## 🎯 5-Minute Setup

### Prerequisites
- PostgreSQL running
- Node.js 16+
- Flutter 3.11+

---

## 📦 Step 1: Backend Setup (3 minutes)

```bash
cd backend

# 1. Install dependencies
npm install

# 2. Setup database (run this once)
psql -U postgres -d anetwork -f database_schema.sql

# 3. Start server
npm start
```

✅ You should see:
```
✅ PostgreSQL connected
Server running on http://localhost:3000
```

---

## 📱 Step 2: Flutter App Setup (2 minutes)

**In a new terminal:**

```bash
cd my_app

# 1. Get dependencies
flutter pub get

# 2. Update backend URL in lib/api.dart
# Change: const String baseUrl = "http://127.0.0.1:3000"
# For Android emulator: Use your machine's IP (e.g., http://192.168.1.100:3000)

# 3. Run app
flutter run
```

---

## 🧪 Test the App

### 1. Register
- Email: `test@example.com`
- Password: `password123`

### 2. Start Mining
- Click "Start Mining" button
- App will count down 6 hours (shows remaining time)
- When timer reaches 0:00:00 → Rewards mined! ✅

### 3. Check Leaderboard
- View top miners globally
- See your ranking

### 4. View Profile
- Check total earnings
- See network statistics

---

## 🔧 Troubleshooting

| Issue | Solution |
|-------|----------|
| "Connection refused" | Backend not running or wrong API URL |
| "Database not found" | Run: `createdb anetwork` |
| "User already exists" | Use different email or query: `DELETE FROM users;` |
| Video not loading | Add video.mp4 to assets folder |
| App crashes on start | Run `flutter pub get` again |

---

## 🚀 Next Steps

1. **Customize** - Add your branding/logo
2. **Deploy** - Use Docker/AWS for production
3. **Database** - Add real users for testing
4. **Security** - Change JWT_SECRET in .env

---

## 📝 Important Files

| File | Purpose |
|------|---------|
| `backend/.env` | Database credentials |
| `backend/database_schema.sql` | Database tables |
| `my_app/lib/api.dart` | Backend API URL |
| `my_app/lib/main.dart` | App UI & logic |

---

## 💡 Tips

- For production: Replace `localhost` with your server IP
- Backend logs show all API calls
- Each mining session = exactly 6 hours
- Check `network_stats` table for global state
- Clear user data: `DELETE FROM users; DELETE FROM mining_sessions;`

---

**Ready to mine? Start the backend and run the app! ⛏️**
