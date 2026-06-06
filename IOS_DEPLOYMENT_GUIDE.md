# 📱 iOS Deployment Guide for A-Network

## ✅ iOS App Now Available!

Your A-Network mining app is now configured for both **Android** and **iOS**!

---

## 🎯 iOS Configuration Complete

### What's Been Updated:

✅ **App Name:** A-Network (Display Name)
✅ **Bundle Name:** A-Network Mining
✅ **iOS Ads:** Google Mobile Ads integrated
✅ **Privacy Permissions:** Added for iOS 14.5+ ATT (App Tracking Transparency)
✅ **Network Settings:** Configured for ad loading
✅ **Flutter Ads:** Embedded views enabled

---

## 🔑 Prerequisites for iOS Build

### 1. System Requirements
- **macOS** (Xcode required)
- **Xcode 12.0+** - Download from App Store
- **iOS SDK** 11.0 or higher
- **CocoaPods** package manager
- **Xcode Command Line Tools**

### 2. Install Xcode

```bash
# Install Xcode from App Store (automatic)
# Or from command line:
xcode-select --install

# Verify installation
xcode-select -p
# Should return: /Applications/Xcode.app/Contents/Developer
```

### 3. Pod Dependencies

```bash
cd my_app/ios
pod repo update  # Update CocoaPods
pod deintegrate  # Clean old pods
pod install      # Install dependencies
```

---

## 🏗️ Building for iOS

### Development Build (Testing)

```bash
cd my_app

# Clean build
flutter clean

# Get dependencies
flutter pub get

# Run on iOS (requires Mac + iPhone/simulator)
flutter run -d iphone
```

### Release Build for App Store

```bash
cd my_app

# Generate release build
flutter build ios --release

# Output: build/ios/iphoneos/
```

### App Store Build Package (Recommended)

```bash
cd my_app

# Create App Store build
flutter build ios --release --export-to-app-store

# Or create IPA manually:
flutter build ios --release
cd build/ios/iphoneos
xcodebuild -exportArchive -archivePath Runner.xcarchive -exportPath output -exportOptionsPlist exportOptions.plist
```

---

## 🔐 iOS App Signing

### 1. Create Apple Developer Account

1. Visit: https://developer.apple.com
2. Enroll in Apple Developer Program ($99/year)
3. Create App ID on App Store Connect

### 2. Configure Code Signing in Xcode

```bash
cd my_app/ios
open Runner.xcworkspace  # NOT Runner.xcodeproj
```

**In Xcode:**
1. Select "Runner" in Project Navigator
2. Go to "Build Settings"
3. Under "Signing":
   - Team: Select your team
   - Signing Certificate: Select your certificate
   - Provisioning Profile: Select your profile

### 3. Update Bundle Identifier

```bash
# In Xcode:
1. Runner target → General tab
2. Bundle Identifier: com.anetwork.mining (or your own)
3. Make sure it matches App ID in App Store Connect
```

---

## 📦 Submit to App Store

### Step 1: Create App Store Connect Record

1. Visit: https://appstoreconnect.apple.com
2. Click "My Apps" → "+"  → "New App"
3. Fill in:
   - **Name:** A-Network
   - **Bundle ID:** com.anetwork.mining
   - **SKU:** anetwork-mining-2026

### Step 2: Fill App Information

1. **App Store:** → **App Information**
   - Category: Productivity or Games
   - Subcategory: Utilities
   - Privacy Policy URL: (required)

2. **Pricing and Availability**
   - Price: Free
   - Availability: All countries or select

3. **App Privacy**
   - Data requested by Apple developers

### Step 3: Prepare Screenshots

**Required sizes:**
- iPhone 6.7": 1284 x 2778
- iPad Pro 12.9": 2048 x 2732

**Recommended: 2-5 screenshots showing:**
- Mining screen
- Leaderboard
- Profile
- Ads
- Features

### Step 4: Create Build

```bash
cd my_app

# Clean
flutter clean
flutter pub get

# Build
flutter build ios --release
```

### Step 5: Upload to App Store Connect

**Option 1: Using Xcode (Easiest)**

```bash
cd my_app/ios
open Runner.xcworkspace

# In Xcode:
# 1. Product → Archive
# 2. Wait for build to complete
# 3. Click "Distribute App"
# 4. Select "App Store Connect"
# 5. Follow the upload process
```

**Option 2: Using Transporter (Alternative)**

```bash
# Login to Transporter
# Download from App Store

# Or command line:
xcrun altool --upload-app --file your-app.ipa \
  --type ios \
  --apiKey YOUR_API_KEY \
  --apiIssuer YOUR_ISSUER_ID
```

---

## 🎨 Ad Unit Configuration for iOS

### Your Rewarded Ad Unit (Same as Android):
```
Ad Unit ID: ca-app-pub-3536954332898219/5411889212
Platform: iOS (same ID works for both)
Format: Rewarded
```

### Update iOS Code

**File: lib/ads_service.dart**

The code automatically detects iOS/Android and uses same ad IDs!

**iOS-specific configuration in Info.plist:**
```xml
<key>GADApplicationIdentifier</key>
<string>ca-app-pub-xxxxxxxxxxxxxxxx~yyyyyyyyyy</string>
```

Replace with your AdMob **iOS App ID** (not the Android one).

---

## 📋 iOS App Store Review Guidelines

### What Apple Reviews:

1. **Functionality** - Must work as described
2. **Design** - Quality UI/UX expected
3. **Content** - No objectionable content
4. **Ads** - Must follow Apple ad policies
5. **Privacy** - Must have proper privacy policy

### Important for Your App:

✅ Privacy Policy (required!)
✅ Clear app description
✅ Professional screenshots
✅ Proper ad disclosures
✅ No fake mining (explain it's simulated)

### Add Privacy Policy Disclosure

**In App Store Connect:**
1. Go to App Information
2. Under "App Privacy"
3. Indicate your app uses ads
4. Add tracking disclosure

---

## ✅ iOS vs Android Differences

| Feature | Android | iOS |
|---------|---------|-----|
| Build Platform | Linux/Mac/Windows | **macOS only** |
| Store | Google Play | App Store |
| App Signing | Keystore | Certificates |
| Review Time | 4-24 hours | 24-48 hours |
| Ads Requirements | Consent (optional) | ATT (required) |
| Privacy | Less strict | More strict |

---

## 🚀 Build Commands Reference

### iOS Development

```bash
# Run on simulator
flutter run -d iphonesimulator

# Run on specific simulator
flutter run -d "iPhone 12 Pro Max"

# List available simulators
xcrun simctl list devices
```

### iOS Release

```bash
# Test flight (internal testing)
flutter build ios --release
# Then upload via TestFlight in App Store Connect

# Production release
flutter build ios --release --export-to-app-store
```

### Troubleshooting iOS

```bash
# Update pods
cd ios && pod repo update && pod install && cd ..

# Clean build
flutter clean && flutter pub get && flutter build ios --release

# Check for issues
flutter analyze

# Verbose build
flutter build ios --verbose
```

---

## 📊 iOS Build Output

### After Building

```
build/ios/
├── iphoneos/
│   ├── Runner.app           (Compiled app)
│   └── Runner.xcarchive     (Archive for TestFlight)
│
├── iphonesimulator/
│   └── Runner.app           (Simulator build)
│
└── Release-iphoneos/
    └── Runner.ipa           (App package for App Store)
```

---

## 🎯 Testing on iOS

### TestFlight (Beta Testing)

1. **Create build**
   ```bash
   flutter build ios --release
   ```

2. **Upload to TestFlight (via Xcode)**
   - Product → Archive
   - Upload
   - Wait for processing (usually 5-30 min)

3. **Invite Testers**
   - In App Store Connect
   - Internal testers (your team)
   - Or external testers (up to 10,000)

4. **Testers Receive Link**
   - Use TestFlight app
   - Install and test your app

### On Test Device

- Install TestFlight from App Store
- Receive invite from developer
- Install your app
- Test all features
- Provide feedback

---

## 🔐 App Store Connect Passwords

### Your iOS App ID

```
Team ID: (from Apple)
Bundle ID: com.anetwork.mining
App ID: (generated by Apple)
SKU: anetwork-mining-2026
```

### Signing Certificates

Keep these safe:
- Distribution Certificate (.p12)
- Provisioning Profile (.mobileprovision)
- Apple ID credentials

---

## ⏱️ Timeline: App Store Submission

### Day 1: Preparation
- Create Apple Developer Account ($99)
- Create App ID in App Store Connect
- Prepare screenshots & description

### Day 2: Build & Test
- Build iOS release
- Test on TestFlight
- Internal testers verify

### Day 3-5: Refinement
- Fix any issues found
- Improve screenshots
- Add release notes

### Day 6: Submit
- Final build
- Submit for review
- Apple reviews (24-48 hrs)

### Day 7: Launch 🎉
- App approved
- Live on App Store
- Available to all iOS users

---

## 📱 Device Support

### Minimum iOS Version
- iOS 11.0 (Flutter requirement)
- iOS 12.0+ (Recommended)
- iOS 13.0+ (Latest features)

### Devices Supported
- iPhone: All models (iPhone 6s and newer)
- iPad: All models (iPad 5th gen and newer)
- iPod Touch: 7th generation and newer

---

## 💡 iOS Specific Tips

1. **Use macOS for Building**
   - iOS builds require macOS
   - Windows/Linux users need Mac setup

2. **TestFlight First**
   - Always use TestFlight for beta testing
   - Get user feedback before App Store

3. **Update Certificates**
   - Signing certificates expire after 1 year
   - Renew before expiration

4. **Monitor Crashes**
   - Use Xcode Organizer to monitor
   - Fix crashes reported by users

5. **Version Management**
   - Version code must increment
   - matches iOS app version

---

## 🎁 Bonus: Cross-Platform Build Script

**Build for Both Platforms:**

```bash
#!/bin/bash
echo "🚀 Building for Android..."
flutter build appbundle --release

echo "🚀 Building for iOS..."
flutter build ios --release

echo "✅ Both builds complete!"
echo "📱 Android: build/app/outputs/bundle/release/app-release.aab"
echo "📱 iOS: build/ios/iphoneos/"
```

---

## ✅ iOS Deployment Checklist

Before submitting to App Store:

```
SETUP
☑ Apple Developer Account created ($99)
☑ App ID created in App Store Connect
☑ Code signing certificates generated
☑ Provisioning profile created

APP INFO
☑ App name: A-Network
☑ Bundle ID: com.anetwork.mining
☑ Privacy policy written
☑ App description complete

BUILD
☑ Flutter clean & pub get
☑ Code signing configured
☑ Release build successful
☑ No build warnings/errors

TESTING
☑ TestFlight internal test passed
☑ External testers invited
☑ Bug fixes applied
☑ Ads display correctly

STORE
☑ Screenshots (2-5) uploaded
☑ Icon provided (512x512)
☑ Category selected
☑ Content rating submitted

SUBMISSION
☑ Version code incremented
☑ Release notes written
☑ Privacy policy URL added
☑ All required info complete
```

---

## 🎉 iOS Launch Status

✅ **Ready for:**
- Building on macOS
- Testing on iOS devices
- Submitting to App Store
- Cross-platform deployment

---

## 📞 iOS Resources

- **Apple Developer:** https://developer.apple.com
- **App Store Connect:** https://appstoreconnect.apple.com
- **Xcode:** Free from Mac App Store
- **TestFlight:** Built into App Store Connect
- **Flutter iOS:** https://flutter.dev/docs/deployment/ios

---

## 🚀 Next: Build for iOS!

1. **Make sure you're on macOS**
2. **Install Xcode & tools**
3. **Run:** `flutter build ios --release`
4. **Upload via Xcode or Transporter**
5. **Test on TestFlight**
6. **Submit to App Store**

---

**Your app is now ready for both Android & iOS! 🎉**

Good luck with your iOS launch!
