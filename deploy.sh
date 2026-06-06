#!/bin/bash
# 🚀 Quick Deploy Script for Google Play Store
# Run this to prepare your app for Play Store upload

echo "========================================="
echo "   A-Network Play Store Deployment"
echo "========================================="
echo ""

cd my_app || exit

# Step 1: Clean
echo "🧹 Step 1: Cleaning build files..."
flutter clean
echo "✅ Clean complete"
echo ""

# Step 2: Get dependencies
echo "📦 Step 2: Getting dependencies..."
flutter pub get
echo "✅ Dependencies ready"
echo ""

# Step 3: Analyze
echo "🔍 Step 3: Analyzing code..."
flutter analyze --fatal-infos
echo "✅ Analysis complete"
echo ""

# Step 4: Build APK for testing
echo "🏗️  Step 4: Building release APK (for local testing)..."
flutter build apk --release
echo "✅ APK ready at: build/app/outputs/flutter-apk/app-release.apk"
echo ""

# Step 5: Build App Bundle for Play Store
echo "🎁 Step 5: Building App Bundle (for Play Store)..."
flutter build appbundle --release
echo "✅ App Bundle ready at: build/app/outputs/bundle/release/app-release.aab"
echo ""

# Step 6: Show file sizes
echo "📊 Step 6: Build artifacts size..."
echo ""
echo "APK Size:"
du -h build/app/outputs/flutter-apk/app-release.apk
echo ""
echo "App Bundle Size:"
du -h build/app/outputs/bundle/release/app-release.aab
echo ""

# Step 7: Summary
echo "========================================="
echo "✅ ALL BUILD STEPS COMPLETED!"
echo "========================================="
echo ""
echo "📋 What's Next:"
echo "1. Get AdMob App ID & Ad Unit IDs"
echo "2. Update lib/ads_service.dart with your Ad IDs"
echo "3. Update android/app/src/main/AndroidManifest.xml"
echo "4. Test APK locally on your device"
echo "5. Create Google Play Developer Account"
echo "6. Upload app-release.aab to Play Console"
echo ""
echo "📚 Documentation:"
echo "   - GOOGLE_PLAY_DEPLOYMENT.md (Full guide)"
echo "   - DEPLOYMENT_CHECKLIST.md (Quick checklist)"
echo "   - BUILD_COMMANDS.md (Reference)"
echo ""
echo "🚀 Ready to deploy!"
