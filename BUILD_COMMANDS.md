# 🚀 Build Commands Reference

## Quick Commands for Google Play Store Deployment

---

## 1️⃣ Clean & Prepare

```bash
cd my_app

# Remove old builds
flutter clean

# Get latest dependencies
flutter pub get

# Analyze project for issues
flutter analyze
```

---

## 2️⃣ Generate Release APK (For Testing)

**Command:**
```bash
flutter build apk --release
```

**Output:** `build/app/outputs/flutter-apk/app-release.apk`

**Use Case:** 
- Local testing on device
- Quick testing before Play Store upload
- ~45 MB file size

**Test:**
```bash
# Install on connected device
adb install -r build/app/outputs/flutter-apk/app-release.apk

# Run
adb shell am start -n com.anetwork.mining/.MainActivity
```

---

## 3️⃣ Generate Release App Bundle (For Play Store) ⭐

**Command:**
```bash
flutter build appbundle --release
```

**Output:** `build/app/outputs/bundle/release/app-release.aab`

**Use Case:**
- ✅ Required for Google Play Store submission
- Better compression than APK
- Google Play handles device-specific APKs
- Recommended method

**Size:** ~30 MB (Play Store optimizes per device)

---

## 4️⃣ Build with Version Increment

**Update version in pubspec.yaml:**
```yaml
# Before
version: 1.0.0+1

# After (for next release)
version: 1.0.1+2
# Format: version+build_number
```

**Then build:**
```bash
flutter build appbundle --release
```

---

## 5️⃣ Build for Multiple Architectures

**APK for multiple architectures:**
```bash
flutter build apk --release --split-per-abi
```

**Output:**
- `app-armeabi-v7a-release.apk` (32-bit ARM - older devices)
- `app-arm64-v8a-release.apk` (64-bit ARM - modern devices)
- `app-x86_64-release.apk` (Intel processors)

---

## 6️⃣ Build Specific Architecture

**Only 64-bit (recommended):**
```bash
flutter build appbundle --release --target-platform android-arm64
```

---

## 7️⃣ Verify Signing

```bash
# Check if APK is signed
jarsigner -verify -verbose build/app/outputs/flutter-apk/app-release.apk

# Get signature details
keytool -printcert -jarfile build/app/outputs/flutter-apk/app-release.apk
```

---

## 8️⃣ Check App Size

```bash
# Analyze APK size
flutter build apk --release --analyze-size
```

**Reduce size if needed:**
1. Enable ProGuard: `minifyEnabled true`
2. Enable shrinkResources: `shrinkResources true`
3. Remove unused assets
4. Compress images

---

## 9️⃣ Logs & Debugging

**View build logs:**
```bash
flutter build appbundle --release -v
```

**Check device logs:**
```bash
adb logcat | grep "A-Network"
```

**See ads debug info:**
```bash
adb logcat | grep "I/Ads"
```

---

## 🔟 Test AdMob Ads Locally

```bash
# Install debug APK
flutter run -v

# Or with release mode testing
flutter run --release
```

**Check for:**
- ✅ Banner ads displaying
- ✅ No ad errors in logcat
- ✅ Interstitial ads loading
- ✅ Rewarded ads showing

---

## 🔁 Common Build Commands

```bash
# Full release build
flutter build appbundle --release

# APK with stats
flutter build apk --release --analyze-size

# Verbose output (for debugging)
flutter build appbundle --release -v

# Split APK per architecture
flutter build apk --release --split-per-abi

# Clean cache
flutter clean && flutter pub get

# Check dependencies
flutter pub deps

# Get packages
flutter pub global activate flutter_launcher_icons
```

---

## ⚙️ Build Configuration (android/app/build.gradle)

Example configuration:

```gradle
android {
    compileSdkVersion flutter.compileSdkVersion

    defaultConfig {
        applicationId "com.anetwork.mining"
        minSdkVersion flutter.minSdkVersion
        targetSdkVersion flutter.targetSdkVersion
        versionCode flutterVersionCode.toInteger()
        versionName flutterVersionName
    }

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
            minifyEnabled true
            shrinkResources true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
```

---

## 📊 Build Output Locations

| What | Where |
|------|-------|
| Release APK | `build/app/outputs/flutter-apk/app-release.apk` |
| App Bundle | `build/app/outputs/bundle/release/app-release.aab` |
| Split APKs | `build/app/outputs/apk/release/` |
| Build logs | `build/` directory |
| Mapping file | `build/app/outputs/mapping/release/mapping.txt` |

---

## ⏱️ Build Times

Typical build times (first build, varies by machine):
- **APK:** 1-3 minutes
- **App Bundle:** 2-5 minutes
- **Full Rebuild:** 5-10 minutes
- **Incremental Build:** 30 seconds - 2 minutes

---

## 🚨 Troubleshooting Build Issues

```bash
# Build fails - try clean build
flutter clean
flutter pub get
flutter build appbundle --release

# Java error - check Java version
java -version

# Gradle error - check Android SDK
flutter doctor -v

# Out of memory - increase heap
export ANDROID_GRADLE_DAEMON_HEAP_SIZE=2048m
flutter build appbundle --release

# Permission denied on keystore
chmod 600 android/app/release.keystore
```

---

## 📝 Version Code Increment Strategy

```
Version Format: Major.Minor.Patch+BuildNumber

Examples:
1.0.0+1     - Initial release
1.0.1+2     - Bug fix update
1.1.0+3     - Minor feature update
2.0.0+4     - Major update

Rules:
- Always increment build number (+1, +2, +3...)
- Major.Minor.Patch follows semantic versioning
- Build number must always increase
- Google Play rejects same build number
```

---

## ✅ Pre-Release Checklist

Before uploading to Play Store:

```bash
# 1. Clean build
flutter clean

# 2. Get dependencies
flutter pub get

# 3. Analyze code
flutter analyze

# 4. Run tests (if you have tests)
flutter test

# 5. Check version
grep "version:" pubspec.yaml

# 6. Build release
flutter build appbundle --release

# 7. Verify signing
jarsigner -verify build/app/outputs/flutter-apk/app-release.apk

# 8. Check size
du -h build/app/outputs/bundle/release/app-release.aab
```

---

## 🎯 Final Build Command

**Ready to upload?**

```bash
# One-liner for final release
flutter clean && \
flutter pub get && \
flutter build appbundle --release && \
echo "✅ Build complete! Upload: build/app/outputs/bundle/release/app-release.aab"
```

---

## 📦 Upload to Play Console

After building, upload file:
- Go to https://play.google.com/console
- Select your app
- Click "Release > Production"
- Click "Create new release"
- Upload: `build/app/outputs/bundle/release/app-release.aab`

---

**Ready to deploy? Run the commands above and upload to Play Store! 🚀**
