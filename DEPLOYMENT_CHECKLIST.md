# ✅ Google Play Store Deployment Checklist

## Phase 1: Preparation (Pre-Deployment)

- [ ] API endpoint updated to: `https://api.a-network.net`
- [ ] Google AdMob account created
- [ ] Ad Unit IDs obtained (Banner, Interstitial, Rewarded)
- [ ] Ad IDs added to `lib/ads_service.dart`
- [ ] AdMob App ID added to `android/app/src/main/AndroidManifest.xml`
- [ ] Backend server is live and accessible
- [ ] Database is initialized and healthy
- [ ] SSL certificate configured on backend domain

## Phase 2: App Signing

- [ ] Keystore file created (`android/app/release.keystore`)
- [ ] Keystore password saved securely
- [ ] `android/key.properties` created with signing config
- [ ] `android/app/build.gradle` configured for signing
- [ ] Release build tested locally: `flutter build apk --release`

## Phase 3: Build Generation

- [ ] `flutter clean` executed
- [ ] `flutter pub get` executed
- [ ] Version incremented in `pubspec.yaml`
- [ ] Release APK built: `flutter build apk --release`
- [ ] App Bundle (.aab) built: `flutter build appbundle --release`
- [ ] Build size < 100MB
- [ ] No build warnings or errors

## Phase 4: Google Play Developer Account

- [ ] Google Play Developer Account created
- [ ] $25 registration fee paid
- [ ] Identity verified
- [ ] Merchant account set up (if monetizing)

## Phase 5: Play Console Setup

- [ ] New app created on Google Play Console
- [ ] App name: "A-Network" or "A-Network Crypto Mining"
- [ ] Default language: English
- [ ] App category: Productivity / Tools
- [ ] Free app selected

## Phase 6: Store Listing

- [ ] App title & subtitle entered
- [ ] Short description (80 chars) written
- [ ] Full description written (4000 chars)
- [ ] Screenshots created (2-5 images, 320x569 or 1440x2560)
- [ ] Feature graphic created (1024x500)
- [ ] Icon uploaded (512x512 PNG)
- [ ] Privacy policy URL added
- [ ] Contact email added
- [ ] Website URL added (if available)

## Phase 7: Content Rating

- [ ] Content rating questionnaire completed
- [ ] IAMAI self-certification submitted
- [ ] Rating assigned (usually 3+)

## Phase 8: Testing Release

- [ ] Internal testing track created
- [ ] App Bundle (.aab) uploaded
- [ ] Release notes added
- [ ] 1-2 test users added for internal testing
- [ ] Testing link generated
- [ ] App tested on multiple devices
- [ ] All features tested:
  - [ ] Registration works
  - [ ] Login works
  - [ ] Mining starts/completes
  - [ ] Balance updates
  - [ ] Leaderboard displays
  - [ ] Ads load and display
  - [ ] No crashes in logcat

## Phase 9: Pre-Production Release

- [ ] Beta/closed testing track created
- [ ] Wider tester group invited
- [ ] Tested for 2-3 days
- [ ] Ad performance monitored
- [ ] No critical issues found

## Phase 10: Production Release

- [ ] Final bug fixes applied
- [ ] Version code incremented again
- [ ] App Bundle rebuilt
- [ ] Production release created
- [ ] Screenshots re-verified
- [ ] Pricing: Free (or In-app purchases if planned)
- [ ] Release rollout strategy selected:
  - [ ] 100% immediate (for established apps only)
  - [ ] 5% staged rollout (recommended for first release)
- [ ] Release scheduled or published

## Phase 11: Post-Release Monitoring

- [ ] App live on Google Play Store
- [ ] Installation and crash reports monitored
- [ ] User reviews monitored
- [ ] AdMob revenue tracked
- [ ] Backend logs monitored for errors
- [ ] User feedback collected

## Phase 12: Ad Activation (After 48 hours)

- [ ] Ad unit approval verified in AdMob
- [ ] Test Ad IDs replaced with real Ad Unit IDs
- [ ] `ads_service.dart` updated with production IDs
- [ ] `AndroidManifest.xml` updated with AdMob App ID
- [ ] Version incremented again
- [ ] App Bundle rebuilt
- [ ] New version released to production
- [ ] Ad revenue monitoring enabled

## Phase 13: Maintenance

- [ ] Regular security updates monitored
- [ ] Crash reports handled within 24 hours
- [ ] Feature updates planned and released (monthly)
- [ ] Ad revenue analytics reviewed weekly
- [ ] User retention metrics tracked
- [ ] Rating maintained above 4.0 stars

---

## 📋 Important Files & Credentials

**Keep These Safe:**
- [ ] Keystore password (_store securely_)
- [ ] Keystore file location: `android/app/release.keystore`
- [ ] Google Play Developer account credentials
- [ ] AdMob App ID: `ca-app-pub-xxxxxxxxxxxxxxxx~yyyyyyyyyy`
- [ ] Ad Unit IDs (Banner, Interstitial, Rewarded)
- [ ] Backend API domain: `https://api.a-network.net`

---

## 🚨 Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| Build fails | Run `flutter clean` then rebuild |
| APK too large | Enable ProGuard minification in build.gradle |
| Ads not showing | Check AdMob setup, may need 24-48 hours |
| App crashes | Check Logcat, verify API endpoint |
| Signing fails | Verify keystore permissions and path |
| Upload fails | Ensure correct version code (increment) |

---

## 📱 Test Devices for AdMob

For testing before release:
1. Keep test Ad ID in `ads_service.dart`
2. Test ads will show on test devices
3. After app is live, replace with production IDs
4. Add your test device ID to AdMob dashboard

To find test device ID:
- Run app on phone
- Look in logcat for: `I/Ads: Use RequestConfiguration.Builder().setTestDeviceIds`
- Copy the device ID and add to AdMob

---

## 🎉 Final Checklist Before Submitting

- [ ] All features working
- [ ] No crashes in testing
- [ ] Ads displaying correctly
- [ ] Backend responding
- [ ] SSL certificate valid
- [ ] App permissions OK
- [ ] Privacy policy adequate
- [ ] Screenshots professional
- [ ] Icon and graphics ready
- [ ] Release notes clear
- [ ] Version code correct
- [ ] APK/AAB size acceptable

---

**Status: READY FOR DEPLOYMENT** ✅

Once all items are checked, your app is ready for:
1. Internal testing
2. Closed testing (beta)
3. Production release on Google Play Store

Good luck! 🚀
