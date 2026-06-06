# ⚡ iOS Quick Start Guide

## 🎯 Get Your iOS App Built in 15 Minutes!

This is the fastest path from setup to testing on iOS devices.

---

## ✅ Prerequisites Check

```bash
# 1. macOS?
uname -s
# Should output: Darwin

# 2. Xcode installed?
xcode-select -p
# Should output: /Applications/Xcode.app/Contents/Developer

# 3. Flutter installed?
flutter --version
# Should output: Flutter version X.X.X
```

**If any command fails, go back and install the missing tool.**

---

## 🚀 Fast Track: Build & Deploy in 5 Steps

### Step 1: Clean & Update (2 minutes)

```bash
cd my_app

# Clean everything
flutter clean

# Get latest dependencies
flutter pub get
```

### Step 2: Build iOS App (5 minutes)

```bash
# For testing on simulator or device
flutter build ios --release

# Output will be at: build/ios/iphoneos/
```

### Step 3: Choose Your Device

**Option A: iOS Simulator** (Fastest, No Device Needed)

```bash
# List available simulators
xcrun simctl list devices

# Run on default iPhone simulator
flutter run -d iphonesimulator

# Or specific simulator
flutter run -d "iPhone 14 Pro Max"
```

**Option B: Physical iOS Device** (Better Testing)

1. Connect iPhone via USB
2. Trust this computer (on phone)
3. Run:
```bash
flutter run -d iphone
```

### Step 4: Test the App (3 minutes)

- **Tap "Register"** → Create account
- **Tap "Mining"** → Start mining session
- **Tap "Leaderboard"** → See top miners (ads appear here)
- **Tap "Profile"** → View your stats
- **Check ads** → Should see ads on Mining screen

### Step 5: Check for Errors

```bash
# View detailed logs
flutter logs

# Or build with verbose output
flutter build ios --release --verbose
```

---

## 🎮 Running on iOS Devices

### Development Build (Fastest Iteration)

```bash
cd my_app

# Default: runs on simulator
flutter run

# On specific device by serial
flutter run -d YOUR_DEVICE_ID

# Keep running and hot-reload on code changes
flutter run -d iphone
# Press 'r' to reload after code changes
```

### Device Selection

```bash
# List all iOS devices (simulators + physical)
flutter devices

# Example output:
# iphone (mobile)                    • C1A2D3E4F5G6H7I8 • ios            • iOS 17.0
# iPhone 14 Simulator (simulator)    • 1234567890ABCDEF  • ios            • iOS 17.0

# Use device ID to run
flutter run -d 1234567890ABCDEF
```

---

## 📝 Code Changes Before Building

### 1. Check Your Ad Unit IDs

**File: `lib/ads_service.dart`**

Look for this section:

```dart
// REWARD AD UNIT - Your Specific Mining Reward Ad
static const String miningRewardAdUnitId = "ca-app-pub-3536954332898219/5411889212";

// BANNER ADS
static const String bannerAdUnitId = "ca-app-pub-3940256099942544/6300978111";  // TEST

// INTERSTITIAL ADS
static const String interstitialAdUnitId = "ca-app-pub-3940256099942544/1033173712";  // TEST
```

✅ **Your rewarded ad is already set!**
- Rewarded: `ca-app-pub-3536954332898219/5411889212` ✓

⚠️ **To get real ad units:**
1. Visit https://admob.google.com
2. Create Banner ad unit
3. Copy its ID
4. Replace `bannerAdUnitId` in the code
5. Repeat for Interstitial ad unit

### 2. Check API Endpoint

**File: `lib/api.dart`**

```dart
const String baseUrl = "https://api.a-network.net";
```

✅ **Already set to production!** (or your API URL)

### 3. Check AdMob App IDs

**File: `ios/Runner/Info.plist`**

Find this section:
```xml
<key>GADApplicationIdentifier</key>
<string>ca-app-pub-xxxxxxxxxxxxxxxx~yyyyyyyyyy</string>
```

⚠️ **IMPORTANT:** Replace `ca-app-pub-xxxxxxxxxxxxxxxx~yyyyyyyyyy` with your actual iOS AdMob App ID:

1. Visit https://admob.google.com
2. Go to Settings → App settings
3. Find "AdMob App ID" (for iOS app)
4. Copy it (looks like: `ca-app-pub-1234567890123456~9876543210`)
5. Paste it into Info.plist replacing the placeholder

---

## 📦 Building Release Version

### For TestFlight (Beta Testing)

```bash
cd my_app

# Create release build
flutter build ios --release

# Upload via Xcode:
cd build/ios
open Runner.xcworkspace
# In Xcode: Product → Archive → Distribute App

# OR command line:
cd ..
xcodebuild -archivePath build/ios/Runner.xcarchive -exportOptionsPlist exportOptions.plist -exportPath output
```

### For App Store Production

```bash
flutter build ios --release --export-to-app-store
# Creates: build/ios/iphoneos/Runner.ipa
```

---

## 🔧 Troubleshooting iOS Build Issues

### Problem: "Pod install failed"

```bash
cd ios
pod repo update
pod install
cd ..
flutter build ios --release
```

### Problem: "Signing certificate not found"

```bash
# Open Xcode
cd my_app/ios
open Runner.xcworkspace

# In Xcode:
# 1. Runner → Build Settings
# 2. Search "signing"
# 3. Set Team to your Apple ID
# 4. Signing Certificate: choose your certificate
```

### Problem: "Flutter not found"

```bash
# Ensure Flutter is in PATH
which flutter

# If not found, add Flutter to PATH:
export PATH="$PATH:`pwd`/flutter/bin"
```

### Problem: "iOS deployment target mismatch"

```bash
# Fix in pubspec.yaml section or
cd ios
# Edit Podfile:
# platform :ios, '13.0'  <- Ensure this matches
pod install
cd ..
flutter build ios --release
```

### Problem: "Ad unit ID not working"

```
Check:
1. Ad unit ID format: ca-app-pub-XXXX~YYYY
2. iOS vs Android (different IDs)
3. Test ads enabled? (useTestAds = true)
4. AdMob app ID in Info.plist?
```

---

## 📊 Build Output Locations

After `flutter build ios --release`:

```
my_app/build/ios/
├── iphoneos/
│   ├── Runner.app              ← The compiled app
│   ├── Runner.app.dSYM         ← Debug symbols
│   └── Runner.xcarchive        ← Archive for TestFlight
│
└── iphonesimulator/
    └── Runner.app              ← Simulator build
```

---

## 🚀 Deploy to TestFlight (In 5 Steps)

### Step 1: Create Build

```bash
flutter build ios --release
```

### Step 2: Open in Xcode

```bash
cd my_app/ios
open Runner.xcworkspace  # NOT Runner.xcodeproj
```

### Step 3: Archive the App

In Xcode:
1. Select "Runner" in navigator
2. Select "Runner" app (not tests)
3. Product → Archive
4. Wait for build to complete

### Step 4: Upload to TestFlight

In Xcode Organizer:
1. Archives tab
2. Your build
3. "Validate App"
4. "Distribute App"
5. Select "App Store Connect"
6. Fill in details
7. Upload

### Step 5: Test on Physical Device

In App Store Connect:
1. Go to TestFlight
2. Invite testers (your email)
3. Testers install TestFlight app on iPhone
4. Get invite → Install → Test

---

## 📋 Test Checklist

After build, test these features:

```
AUTHENTICATION
☑ Can register new account
☑ Can login with credentials
☑ Session persists after close

MINING
☑ Mining session starts
☑ Timer counts down (6 hours)
☑ Banner ads display
☑ Ads don't block content

LEADERBOARD
☑ Loads top 20 miners
☑ Shows rank, name, balance
☑ Interstitial ad displays

PROFILE
☑ Shows user rank
☑ Shows total earned
☑ Shows network stats (users, eligible)

ADS
☑ Banner ads load
☑ Interstitial ad shows on leaderboard
☑ Rewarded ad works (shows reward)
☑ No excessive ads

PERFORMANCE
☑ App doesn't crash
☑ No lag when scrolling
☑ Fast page transitions
☑ Ads load within 3 seconds
```

---

## 🎯 Getting Production Ad IDs

### Step 1: Create AdMob Account

1. Visit https://admob.google.com
2. Sign in with Google
3. Click "Create account"

### Step 2: Create iOS App

1. Settings → Apps
2. Click "Add app"
3. Select "iOS"
4. App name: "A-Network Mining"
5. App store URL: (leave blank for now)
6. Click "Create"

### Step 3: Get iOS App ID

1. After creation, copy: `ca-app-pub-XXXX~YYYY` format
2. Add to `ios/Runner/Info.plist`:

```xml
<key>GADApplicationIdentifier</key>
<string>ca-app-pub-XXXX~YYYY</string>
```

### Step 4: Create Ad Units

1. Apps → Your app → Ad units
2. Click "Create ad unit"

**For Banner Ads:**
- Format: Banner
- Name: "Mining Banner"
- Copy the Ad Unit ID (looks like: ca-app-pub-XXXX/YYYY)

**For Interstitial:**
- Format: Interstitial
- Name: "Leaderboard Interstitial"
- Copy the Ad Unit ID

**For Rewarded:** (You already have this!)
- Your Rewarded ID: `ca-app-pub-3536954332898219/5411889212`

### Step 5: Update Your Code

**File: `lib/ads_service.dart`**

```dart
// Update these three:
static const String bannerAdUnitId = "YOUR_BANNER_ID";
static const String interstitialAdUnitId = "YOUR_INTERSTITIAL_ID";
static const String miningRewardAdUnitId = "ca-app-pub-3536954332898219/5411889212"; // Already correct
```

### Step 6: Rebuild

```bash
flutter clean
flutter pub get
flutter build ios --release
```

---

## 💡 Pro Tips for iOS

1. **Always use `xcworkspace`** not `.xcodeproj`
   ```bash
   open Runner.xcworkspace  # ✓ Correct
   # NOT: open Runner.xcodeproj
   ```

2. **Clean pods before rebuild**
   ```bash
   cd ios
   rm -rf Pods Podfile.lock
   pod install
   cd ..
   ```

3. **Use TestFlight before App Store**
   - Catch bugs early
   - Get real device feedback
   - Fix issues before public

4. **Keep certificates safe**
   - Distribution certificate enables signing
   - Provisioning profile enables deployment
   - Back them up securely

5. **Monitor crash reports**
   - App Store Connect shows crashes
   - Fix critical bugs before public launch

---

## ✅ iOS Quick Reference

```bash
# Full sequence
flutter clean
flutter pub get
flutter build ios --release

# Testing
flutter run -d iphone
flutter run -d "iPhone 14 Pro Max"
flutter run -d iphonesimulator

# Xcode
cd ios
open Runner.xcworkspace
pod install

# View logs
flutter logs --device

# Check device IDs
flutter devices

# Archive for TestFlight
xcodebuild -archivePath build/ios/Runner.xcarchive -exportOptionsPlist exportOptions.plist -exportPath output
```

---

## 🎉 You're Ready!

1. ✅ Your iOS app is configured
2. ✅ Ads are integrated
3. ✅ Ready to build & test
4. ✅ Ready for TestFlight
5. ✅ Ready for App Store

**Next steps:**
1. Get iOS AdMob App ID
2. Run `flutter build ios --release`
3. Test on device/simulator
4. Deploy to TestFlight
5. Launch on App Store! 🚀

---

## 📞 iOS Docs & Resources

- iOS Deployment: https://flutter.dev/docs/deployment/ios
- Xcode Help: Open Xcode → Help → Xcode Help
- CocoaPods: https://cocoapods.org/
- TestFlight: https://developer.apple.com/testflight/
- App Store Connect: https://appstoreconnect.apple.com

---

**Happy iOS development! 🎨**
