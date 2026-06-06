# 📱 Google Play Store Deployment Guide

## 🎯 Complete Setup for Google Play Store Testing & Release

This guide will take you through all the steps to deploy your A-Network mining app on Google Play Store with working ads.

---

## 📋 Prerequisites

- ✅ Flutter 3.11+
- ✅ Android SDK
- ✅ Google Play Developer Account ($25 one-time)
- ✅ Google AdMob Account (free)
- ✅ JDK 11 or higher
- ✅ Keystore file for signing

---

## 🎪 Step 1: Setup Google AdMob

### 1. Create Google AdMob Account

1. Visit: https://admob.google.com
2. Sign in with your Google Play Developer account
3. Click "Create App"
4. Select "Android"

### 2. Add Your App

1. Enter app name: **A-Network**
2. Accept terms
3. Click "Create"
4. You'll get an **AdMob App ID**: `ca-app-pub-xxxxxxxxxxxxxxxx~yyyyyyyyyy`

### 3. Create Ad Units

You'll need THREE ad units:

**🎯 A. Banner Ad Unit**
- Name: "Banner Ad"
- Format: Banner (320x50)
- Copy the Ad Unit ID

**🎬 B. Interstitial Ad Unit**
- Name: "Interstitial Ad"
- Format: Interstitial
- Copy the Ad Unit ID

**🎁 C. Rewarded Ad Unit**
- Name: "Rewarded Ad"
- Format: Rewarded
- Copy the Ad Unit ID

### 4. Update App with Your Ad IDs

Edit `lib/ads_service.dart`:

```dart
class AdsService {
  // Your actual AdMob App ID
  static const String admobAppId = "ca-app-pub-xxxxxxxxxxxxxxxx~yyyyyyyyyy";

  // Your actual Ad Unit IDs (Replace these!)
  static const String bannerAdUnitId = "ca-app-pub-3940256099942544/6300978111";
  static const String interstitialAdUnitId = "ca-app-pub-3940256099942544/1033173712";
  static const String rewardedAdUnitId = "ca-app-pub-3940256099942544/5224354917";
}
```

Also update `android/app/src/main/AndroidManifest.xml`:

```xml
<meta-data
    android:name="com.google.android.gms.ads.APPLICATION_ID"
    android:value="ca-app-pub-xxxxxxxxxxxxxxxx~yyyyyyyyyy"/>
```

---

## 🔑 Step 2: Sign Your App

### 1. Create a Keystore File

```bash
cd android/app

# Generate keystore
keytool -genkey -v -keystore release.keystore -keyalg RSA -keysize 2048 -validity 10000 -alias anetwork

# You'll be asked for:
# Keystore password (e.g., myKeyStorePass)
# Key name: anetwork
# Key password (can be same as keystore)
# First name: Your Name
# Last name: A-Network
```

**⚠️ IMPORTANT: Save your passwords somewhere safe!**

### 2. Create Signing Configuration

Create `android/key.properties`:

```properties
storePassword=myKeyStorePass
keyPassword=myKeyPassword
keyAlias=anetwork
storeFile=release.keystore
```

### 3. Configure Gradle

Edit `android/app/build.gradle`:

```gradle
android {
    // ... existing config ...

    signingConfigs {
        release {
            keyAlias keystoreProperties['keyAlias']
            keyPassword keystoreProperties['keyPassword']
            storeFile file(keystoreProperties['storeFile'])
            storePassword keystoreProperties['storePassword']
        }
    }

    buildTypes {
        release {
            signingConfig signingConfigs.release
            shrinkResources true
            minifyEnabled true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
```

### Load Signing Secrets

At the top of `android/app/build.gradle`, add:

```gradle
def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file('key.properties')
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}
```

---

## 📦 Step 3: Build Release APK

### Generate Release Build

```bash
cd my_app

# Get latest dependencies
flutter pub get

# Build release APK
flutter build apk --release

# Output: build/app/outputs/flutter-apk/app-release.apk
```

### Generate Release App Bundle (Recommended)

```bash
# Build App Bundle (recommended for Play Store)
flutter build appbundle --release

# Output: build/app/outputs/bundle/release/app-release.aab
```

---

## 🚀 Step 4: Create Google Play Developer Account

1. Visit: https://play.google.com/console
2. Sign in with your Google account
3. Pay $25 registration fee
4. Fill out account details
5. Verify your identity

---

## 📝 Step 5: Create App on Play Console

### 1. Create New App

1. Click "Create app"
2. Enter app name: **A-Network**
3. Default language: English
4. App type: Applications
5. Category: Productivity or Tools
6. Paid or Free: **Free**

### 2. Fill Store Listing

Go to **Store listing**:

**App name:**
```
A-Network Crypto Mining
```

**Short description:**
```
Mine cryptocurrency, earn tokens. Complete 6-hour mining sessions and climb the global leaderboard!
```

**Full description:**
```
A-Network is a decentralized cryptocurrency mining platform where users can:

⛏️ Mine tokens through 6-hour sessions
🏆 Compete on global leaderboards
💰 Earn rewards based on network halving events
📊 Track real-time network statistics

Features:
• Easy registration and login
• 6-hour mining sessions
• Dynamic reward system
• Live leaderboard rankings
• Network statistics tracking
• Secure JWT authentication

Mining mechanics:
- Earn 0.001 ANET per second of mining
- Rewards increase with network halvings
- Max supply: 21 million tokens
- Network mode after max supply reached

Start mining today and become a crypto miner!
```

**Screenshots:**
- Upload 2-5 screenshots (at least 320x569 or 1440x2560 resolution)
- Show: Login screen, Mining screen, Leaderboard, Profile

**Feature graphic** (1024x500):
- Create a promotional image with your app branding

**Icon** (512x512):
- PNG format with at least 48 pixel padding

**Content rating:**
1. Go to Content rating section
2. Fill out questionnaire
3. Get auto-assigned rating (usually 3+)

### 3. App Signing

1. Go to **Release > Setup > App signing**
2. Google will manage your app signing (recommended)
3. Upload your .aab file later

### 4. Privacy Policy

1. Create privacy policy (required!)
   - Use: https://app-privacy-policy-template.firebaseapp.com/
   - Or: https://termly.io/products/privacy-policy-generator/

2. Enter URL in **Store listing > App policies**

---

## 📤 Step 6: Upload Build

### Upload for Testing

1. Go to **Release > Testing > Internal testing**
2. Click "Create new release"
3. Upload your `app-release.aab` file
4. Add release notes:
   ```
   v1.0.0 - Initial Release
   
   Features:
   - Crypto mining with 6-hour sessions
   - Global leaderboard
   - Real-time network stats
   - Google AdMob ads integrated
   ```
5. Click "Review release"
6. Click "Start rollout to Internal testing"

### Add Testers

1. After uploading, you'll get a testing link
2. Share link with test devices
3. Testers can install from Play Store link

### Test the App

- ✅ Registration and login
- ✅ Mining functionality
- ✅ Banner ads display
- ✅ Leaderboard updates
- ✅ Balance calculation
- ✅ Network requests

---

## 🎯 Step 7: Submit for Production

### Before Submission

Checklist:
- ✅ Ads are displaying (with test Ad IDs)
- ✅ No crashes or errors
- ✅ Privacy policy link works
- ✅ Content rating submitted
- ✅ All store listing complete
- ✅ Screenshots and graphics uploaded
- ✅ Version code incremented
- ✅ API endpoint is production: `https://api.a-network.net`

### Release to Production

1. Go to **Release > Production**
2. Click "Create new release"
3. Upload updated `app-release.aab`
4. Add version code (increment from previous: 1 → 2)
5. Add release notes
6. Click "Review release"
7. Click "Start rollout to Production"
8. Choose rollout percentage:
   - **Option 1:** 100% immediate (not recommended for first release)
   - **Option 2:** Staged rollout (5% → 25% → 50% → 100%)
   - Recommended: Start 5%, monitor for 1-2 days

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Build rejected | Check version code, API 31+ required |
| Policy violation | Ensure privacy policy adequate |
| Ads not approved | May take 24-48 hours for ad review |
| Crash on launch | Check logs, rebuild with `flutter clean` |

---

## 🎨 Step 8: Replace Test Ads with Real Ads

**Important:** After app is live on Play Store:

1. Delete test Ad Unit IDs from `ads_service.dart`
2. Replace with real Ad Unit IDs from AdMob
3. Increment version code
4. Rebuild: `flutter build appbundle --release`
5. Upload new version to Play Store

```dart
// BEFORE (Test Ads)
static const String bannerAdUnitId = "ca-app-pub-3940256099942544/6300978111";

// AFTER (Real Ads from AdMob)
static const String bannerAdUnitId = "ca-app-pub-YOUR_ID_HERE";
```

---

## 📊 Monitor Your App

### Google Play Console Dashboard

- **Ratings:** Monitor user reviews
- **Crashes:** Investigate ANR/crash reports
- **Installs:** Track download numbers
- **Revenue:** Monitor ad revenue
- **Users:** View active user metrics

### Google AdMob Dashboard

- **Revenue:** Daily/monthly earnings
- **Ad Performance:** CPM, impression rates
- **Audience:** Demographic insights
- **Ad Unit Performance:** Which ads work best

---

## 🔧 Version Updates

### How to Update App

1. Increment version in `pubspec.yaml`:
   ```yaml
   version: 1.0.10+22  # 1.0.10 = version, 22 = build
   ```

2. Rebuild:
   ```bash
   flutter build appbundle --release
   ```

3. Upload new `.aab` to Play Store
4. Set as staged or immediate rollout

---

## 💡 Tips for Success

1. **Test Thoroughly**
   - Use internal testing first
   - Test on multiple devices
   - Check battery usage
   - Verify internet connectivity

2. **Ads Best Practices**
   - Don't show too many interstitials (annoys users)
   - Don't force rewarded ads
   - Let ads load before showing
   - Test with real ad IDs in closed testing

3. **Monitor Reviews**
   - Respond to user feedback
   - Fix reported bugs quickly
   - Update app regularly
   - Maintain high rating (4.0+)

4. **Performance**
   - Keep app size < 100MB
   - Optimize images
   - Reduce network requests
   - Cache data locally

---

## 🎉 Success Indicators

- ✅ App published on Google Play Store
- ✅ Users can download and install
- ✅ Mining functionality works
- ✅ Ads display and generate revenue
- ✅ No critical crashes
- ✅ Users giving 4+ star reviews

---

## 📞 Support Links

- Google Play Console: https://play.google.com/console
- Google AdMob: https://admob.google.com
- Flutter Docs: https://flutter.dev/docs
- Google Play Policies: https://play.google.com/about/developer-content-policy/

---

## ⚠️ Important Reminders

1. **Keystore Password:** Write it down, you'll need it forever!
2. **Privacy Policy:** Required for all apps, don't forget!
3. **Ad Policy:** Google will review ads, may take 48 hours
4. **Testing:** Always test before production release
5. **Backend:** Ensure backend is live at `https://api.a-network.net`

---

**🎉 Congratulations! Your A-Network app is ready for Google Play Store!**

Questions? Check Flutter docs or Google Play policies.
