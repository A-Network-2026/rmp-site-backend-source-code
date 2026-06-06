# A Network - Google Play Store Deployment Guide

**Status:** Ready for Play Store submission  
**Target Launch:** Immediately  
**App ID:** `com.anetwork.app`  
**Signing:** Google Play auto-signing

---

## Pre-Deployment Checklist

- [x] Android applicationId = `com.anetwork.app`
- [x] Bundle ID matches across project
- [x] Release signing configured for Play Store (unsigned bundle)
- [x] Ads disabled (can be re-enabled after account approval)
- [x] Backend endpoint = `https://rmp-site.onrender.com`
- [x] Privacy Policy link = `https://a-network.net/privacy.html`
- [x] Terms link = `https://a-network.net/terms.html`
- [x] App name = "A-Network"
- [x] Legal pages accessible in-app

---

## Build & Deploy Steps

### 1. Build the App Bundle (for Play Store)

```bash
cd e:\A Network Project Codes\A Network\my_app
flutter build appbundle --release
```

**Output:** `build/app/outputs/bundle/release/app-release.aab`

### 2. Create Google Play Developer Account
- Go to https://play.google.com/console
- Sign in with your Google account
- Create a new application (name: "A Network")
- Accept store policies

### 3. Upload to Play Console
1. In Play Console, go to **Release → Production**
2. Click **Create new release**
3. Upload the `.aab` file
4. Review and confirm details
5. Click **Review release** → **Start rollout to production**

---

## In-App Store Data to Complete

These must be filled in Play Console before release:

### App Information
- **App Name:** A Network
- **Short Description:** Web2 + Web3 + Web4 ecosystem. Off-chain utility, on-chain ownership, coordination layer.
- **Full Description:** (See content below)

### Full Description Template
```
A Network is building a long-term digital ecosystem across three connected layers:

Web2 Economy: Off-chain utility, app services, growth systems.
Web3 Economy: Decentralized center with wallet ownership and transparent contracts.
Web4 Economy: Coordination layer connecting Web2 utility with Web3 settlement.

Key Features:
• Multi-slide dashboard with mining, Web3, and Web4 sections
• On-chain token balance viewing via BNB Smart Chain
• Leaderboard and network statistics
• Long-term ecosystem participation focus

Contract: 0x791055A7d52AA392eaE8De04250497f33807E46A
Network: BNB Smart Chain

**Important:** This is not a get-rich-quick scheme. The project is designed for long-term participation, research, and ecosystem development.

Privacy Policy: https://a-network.net/privacy.html
Terms of Service: https://a-network.net/terms.html
```

### Content Rating
- **Category:** Tools / Utilities (or Lifestyle)
- **Ads:** None (ads are disabled in this release)
- **In-app Purchases:** None
- **Data Safety:** Review and certify your data practices

### Screenshots Required (4–8 recommended)
1. Main/Mining slide
2. Web3 integration panel
3. Leaderboard/stats
4. Whitepaper/policy screen

### Graphics Required
- **App Icon:** (use `my_app/assets/logo.png`)
- **Feature Graphic:** 1024×500px (A Network banner)

### Contact Information
- **Support Email:** (your email)
- **Privacy Policy URL:** https://a-network.net/privacy.html
- **Terms & Conditions URL:** https://a-network.net/terms.html

---

## Monetization (Optional - For Future)

When you have AdMob account set up:

1. **Get your AdMob App ID:**
   - Go to https://admob.google.com
   - Create new app
   - Get your `ca-app-pub-XXXXXXX~YYYYYYY` ID

2. **Update ads configuration:**
   - Edit `my_app/android/app/src/main/AndroidManifest.xml`
   - Uncomment and add your AdMob App ID
   - Edit `my_app/lib/ads_service.dart`
   - Change `useTestAds = false` to enable production ads
   - Rebuild and resubmit

---

## Post-Deployment

After release is live:
1. Monitor user feedback in Play Console
2. Check crash reports and ANRs
3. Update app version before next release (increment versionCode)
4. Plan App Store launch for June 16

---

## Troubleshooting

**"Invalid APK/Bundle":** Ensure signing is set to null (unsigned) in build.gradle.kts  
**"Permissions missing":** Check AndroidManifest.xml has INTERNET permission  
**"Test ads visible":** Set `useTestAds = false` in ads_service.dart  

For issues, review: [Flutter Play Store Publishing Guide](https://flutter.dev/docs/deployment/android)
