# A Network - Apple App Store Deployment Guide

**Status:** Ready for App Store submission (June 16 target)  
**App ID:** `com.anetwork.app`  
**Bundle ID:** `com.anetwork.app`  
**Minimum iOS:** 13.0+

---

## Pre-Deployment Checklist

- [x] iOS Bundle ID = `com.anetwork.app`
- [x] Bundle ID matches across Xcode project
- [x] Deployment Target = 13.0
- [x] Ads disabled (can be re-enabled after account approval)
- [x] Backend endpoint = `https://rmp-site.onrender.com`
- [x] Privacy Policy link = `https://a-network.net/privacy.html`
- [x] Terms link = `https://a-network.net/terms.html`
- [x] App name = "A Network"
- [x] Legal pages accessible in-app
- [ ] **YOU MUST HAVE:** Apple Developer Account ($99/year)
- [ ] **YOU MUST HAVE:** Apple ID with admin access to developer account

---

## Pre-Build Requirements

### 1. Create Apple Developer Account (if you don't have one)
- Go to https://developer.apple.com/account
- Join Apple Developer Program ($99/year)
- Wait for email confirmation (can take hours)

### 2. Set Up in Xcode (Mac required)

```bash
# On a Mac, open the project
open -a Xcode e:\A Network Project Codes\A Network\my_app/ios/Runner.xcworkspace
```

**Important:** Always use `.xcworkspace`, not `.xcodeproj`

### 3. Configure Signing in Xcode

In Xcode:
1. Select **Runner** in Project Navigator (left sidebar)
2. Select **Runner** target
3. Go to **Signing & Capabilities** tab
4. For **Team**, select your Apple Developer Team
5. **Bundle Identifier** should be `com.anetwork.app` ✓
6. Check "Automatically manage signing"

### 4. Verify iOS Version

In Xcode:
1. **Build Settings** tab
2. Search for "Deployment Target"
3. Set to **iOS 13.0** minimum

---

## Build & Archive Steps

### 1. Clean Build

```bash
cd e:\A Network Project Codes\A Network\my_app
flutter clean
flutter pub get
```

### 2. Build for iOS Release

```bash
flutter build ios --release
```

### 3. Archive in Xcode (Mac only)

On Mac:
```bash
open -a Xcode ios/Runner.xcworkspace
```

In Xcode:
1. Select **Any iOS Device (arm64)** from device dropdown (top)
2. Go to **Product → Archive**
3. Wait for archive to complete
4. "Organizer" window opens with your archive

### 4. Upload to App Store Connect

In Organizer window:
1. Select your archive
2. Click **Distribute App**
3. Choose **App Store Connect**
4. Follow the wizard:
   - Select signing identity
   - Choose/create Team ID
   - Confirm distribution options
5. Click **Upload**

Wait for App Store Connect to process (5–10 minutes)

---

## In-App Store Data to Complete

Log in to https://appstoreconnect.apple.com and fill these out:

### App Information
- **App Name:** A Network
- **Subtitle:** Long-term digital ecosystem
- **Category:** Utilities
- **Content Rating:** Ages 4+

### Description
```
A Network is a long-term digital ecosystem across three connected layers:

Web2 Economy: Off-chain utility, app services, and growth systems.
Web3 Economy: Decentralized center with wallet ownership and transparent contracts.
Web4 Economy: Coordination layer connecting Web2 utility with Web3 settlement.

Features:
• Multi-slide dashboard with mining, Web3 resources, and ecosystem info
• On-chain token balance viewing via BNB Smart Chain
• Network statistics and leaderboard
• In-app whitepaper with mining rules and formula
• Transparent legal policies

Contract Address: 0x791055A7d52AA392eaE8De04250497f33807E46A
Network: BNB Smart Chain

**Important:** This is not a get-rich-quick scheme. The project is designed for long-term participation, research, and ecosystem development.

Privacy Policy: https://a-network.net/privacy.html
Terms of Service: https://a-network.net/terms.html
```

### Privacy Policy
- **URL:** https://a-network.net/privacy.html
- **Data Collected:** Email, device ID, app activity, wallet addresses (Web3 section only)

### Support URL
- https://a-network.net/

### Screenshots Required (2–5 per device type)

**iPhone:**
1. Main/Mining slide
2. Web3 integration panel
3. Leaderboard/stats

**iPad:** (same as iPhone for first release)

### App Preview (Optional)
- Short 15–30 second video showing app flow

### Keywords
```
crypto, blockchain, web3, bsc, bnb, token, mining, ecosystem
```

---

## Age Rating Questionnaire

Complete the questionnaire in App Store Connect:

**Key answers:**
- **Unrestricted Web Access:** YES (has webview for legal links)
- **Medical/Health Claims:** NO
- **Gambling:** NO (not a get-rich scheme)
- **Frequent/Intense Violence:** NO
- **Contests/Lotteries:** NO

---

## Build Number & Version

Each submission must increment:

1. **Version Number** (e.g., 1.0.0 → 1.0.1)
   - Edit `pubspec.yaml`
   - Change `version: 1.0.0+1` to `version: 1.0.1+2`
   - First part = store version (1.0.1)
   - Second part = build number (2)

2. **Re-archive** with new version

---

## Monetization (Optional - For Future)

When you have AdMob account set up:

1. **Get your AdMob App ID:**
   - Go to https://admob.google.com
   - Create new app
   - Get your `ca-app-pub-XXXXXXX~YYYYYYY` iOS ID

2. **Update ads configuration:**
   - Edit `my_app/ios/Runner/Info.plist`
   - Uncomment and add your AdMob App ID
   - Edit `my_app/lib/ads_service.dart`
   - Change `useTestAds = false` to enable production ads
   - Re-archive and resubmit

---

## Timeline: June 16 Launch Prep

**By June 14:**
- [ ] Test on real iPhone device
- [ ] Verify all links open correctly
- [ ] Check legal pages load
- [ ] Build on Mac and verify archive completes

**On June 15:**
- [ ] Final archive upload
- [ ] Submit for review to App Store

**June 16:**
- [ ] If approved, click "Release to App Store"
- [ ] Monitor for any crashes

---

## Troubleshooting

**"Code signing error":** Ensure Team ID is set in Xcode → Targets → Signing & Capabilities  
**"Invalid Bundle ID":** Must be exactly `com.anetwork.app` everywhere  
**"Missing provisioning profile":** Check "Automatically manage signing" is ON  
**"Build fails in Xcode":** 
```bash
# Try cleaning Flutter cache
flutter clean
cd ios
rm -rf Pods Podfile.lock
cd ..
flutter pub get
flutter build ios --release
```

For issues, review: [Flutter iOS Publishing Guide](https://flutter.dev/docs/deployment/ios)

---

## Support

- iOS Build Help: https://flutter.dev/docs/deployment/ios
- App Store Connect Help: https://help.apple.com/app-store-connect
- Xcode Documentation: https://developer.apple.com/documentation
