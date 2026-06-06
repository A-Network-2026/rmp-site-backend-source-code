# 🔗 A-Network Referral System & Deep Linking Guide

## Overview

The referral system allows users to:
1. Get a unique referral code
2. Generate shareable deep links
3. Share invites via link
4. Have new users automatically apply referral code during signup

---

## 1️⃣ Backend API Endpoints

### ✅ Get Referral Tracker Info
**Endpoint:** `GET /auth/referrals/me`  
**Auth:** Required (Bearer token)

**Response:**
```json
{
  "model": "F1",
  "rewardsEnabled": false,
  "boostsEnabled": false,
  "inviteCode": "ANET5XY",
  "directReferrals": 12,
  "directReferralsCompleted1k": 3,
  "totalReferralSessions": 4500,
  "mySuccessfulSessions": 850,
  "levelTargetSessions": 1000,
  "myRemainingTo1k": 150
}
```

### 🔗 Get Shareable Referral Links
**Endpoint:** `GET /auth/referrals/link`  
**Auth:** Required (Bearer token)

**Backend env configuration:**
```env
REFERRAL_DEEP_LINK_BASE=https://a-network.net/join
ANDROID_PACKAGE_ID=com.anetwork.app
```

**Response:**
```json
{
  "referralCode": "ANET5XY",
  "appDeepLink": "https://a-network.net/join?ref=ANET5XY",
  "playStoreLink": "https://play.google.com/store/apps/details?id=com.anetwork.app&referrer=ref%3DANET5XY",
  "shareMessage": "Join A-Network and use my invite code ANET5XY. Open: https://a-network.net/join?ref=ANET5XY If the app is not installed, use Play Store: https://play.google.com/store/apps/details?id=com.anetwork.app&referrer=ref%3DANET5XY"
}
```

### 📝 Register with Referral Code
**Endpoint:** `POST /auth/register`  
**Body:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123",
  "deviceId": "device-abc123",
  "referralCode": "ANET5XY"
}
```

On successful registration, the `referred_by` field in database links the new user to the referrer.

---

## 2️⃣ Deep Linking Setup (Flutter)

### Android Configuration

**File:** `android/app/src/main/AndroidManifest.xml`

Add intent filter to MainActivity:
```xml
<activity
    android:name=".MainActivity"
    android:exported="true"
    android:launchMode="singleTop"
    ...>
    
    <!-- Existing LAUNCHER intent filter -->
    <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
    </intent-filter>
    
    <!-- ADD THIS: Deep link handler for referral links -->
    <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW"/>
        <category android:name="android.intent.category.DEFAULT"/>
        <category android:name="android.intent.category.BROWSABLE"/>
        
        <!-- Handle https://a-network.net/join?ref=CODE and https://a-network.app/join?ref=CODE -->
        <data android:scheme="https"
              android:host="a-network.app"
              android:pathPrefix="/join"/>
        
        <!-- Handle app:// scheme -->
        <data android:scheme="app"
              android:host="a-network"
              android:pathPrefix="/join"/>
    </intent-filter>
</activity>
```

### iOS Configuration

**File:** `ios/Runner/Info.plist`

Add URL schemes:
```xml
<key>CFBundleURLTypes</key>
<array>
    <dict>
        <key>CFBundleTypeRole</key>
        <string>Editor</string>
        <key>CFBundleURLName</key>
        <string>com.anetwork.app</string>
        <key>CFBundleURLSchemes</key>
        <array>
            <string>app</string>
            <string>anetwork</string>
        </array>
    </dict>
</array>

<key>CFBundleDocumentTypes</key>
<array>
    <dict>
        <key>CFBundleTypeRole</key>
        <string>Editor</string>
        <key>CFBundleTypeName</key>
        <string>A-Network Referral Link</string>
        <key>CFBundleTypeIconFiles</key>
        <array/>
        <key>LSHandlerRank</key>
        <string>Owner</string>
        <key>LSItemContentTypes</key>
        <array>
            <string>com.anetwork.referral</string>
        </array>
    </dict>
</array>

<key>NSUserActivityTypes</key>
<array>
    <string>NSUserActivityTypeBrowsingWeb</string>
</array>
```

### Flutter Package Setup

**File:** `pubspec.yaml`

Add deep linking package:
```yaml
dependencies:
  app_links: ^3.4.0
  uni_links: ^0.0.20
```

Or use native Flutter deep linking (no extra package needed):
```yaml
dependencies:
  # No additional package required - use platform channels
```

---

## 3️⃣ Flutter App Deep Link Handler

### Initialize Deep Link Listener

**In main.dart inside _MiningPageState.initState():**

```dart
import 'package:app_links/app_links.dart';

class _MiningPageState extends State<MiningPage> with WidgetsBindingObserver {
  late AppLinks _appLinks;
  StreamSubscription<Uri>? _deepLinkSubscription;
  String? _pendingReferralCode; // Store referral code before login
  
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    
    // Initialize deep link handler
    _initDeepLinking();
    
    // Rest of init code...
  }
  
  Future<void> _initDeepLinking() async {
    _appLinks = AppLinks();
    
    // Listen to deep links
    _deepLinkSubscription = _appLinks.uriLinkStream.listen(
      (uri) {
        _handleDeepLink(uri);
      },
      onError: (err) {
        debugPrint('Deep link error: $err');
      },
    );
    
    // Handle app opened from terminated state via deep link
    try {
      final initialLink = await _appLinks.getInitialLink();
      if (initialLink != null) {
        _handleDeepLink(initialLink);
      }
    } on PlatformException {
      debugPrint('Failed to get initial link');
    }
  }
  
  void _handleDeepLink(Uri uri) {
    debugPrint('Deep link received: $uri');
    
    // Parse: https://a-network.net/join?ref=ANET5XY
    if (uri.host == 'a-network.net' || uri.host == 'a-network.app' || uri.host == 'a-network') {
      if (uri.path == '/join' || uri.path.startsWith('/join')) {
        final referralCode = uri.queryParameters['ref'];
        
        if (referralCode != null && referralCode.isNotEmpty) {
          setState(() {
            _pendingReferralCode = referralCode;
          });
          
          // If already logged in, show referral dialog
          // If not logged in, auto-fill on auth page
          _showReferralReceivedDialog(referralCode);
        }
      }
    }
  }
  
  void _showReferralReceivedDialog(String code) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF0A1224),
        title: const Text(
          '✨ Referral Link Detected',
          style: TextStyle(color: Colors.cyanAccent),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'You\'ve been invited with code: $code',
              style: const TextStyle(color: Colors.white70),
            ),
            const SizedBox(height: 10),
            const Text(
              'This code will be automatically applied to your signup.',
              style: TextStyle(color: Colors.white70, fontSize: 12),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text(
              'Got it',
              style: TextStyle(color: Colors.cyanAccent),
            ),
          ),
        ],
      ),
    );
  }
  
  @override
  void dispose() {
    _deepLinkSubscription?.cancel();
    super.dispose();
  }
}
```

### Auto-Fill Referral Code on Auth Page

**In AuthPage widget:**

```dart
class _AuthPageState extends State<AuthPage> {
  final emailCtrl = TextEditingController();
  final passCtrl = TextEditingController();
  final referralCtrl = TextEditingController();
  
  String? _referralCodeFromDeepLink;
  
  @override
  void initState() {
    super.initState();
    // App will pass the pending referral code to us
    _checkForDeepLinkReferral();
  }
  
  void _checkForDeepLinkReferral() {
    // This will be called after the app detects a deep link
    // The referral code should be passed here from main.dart
    // For now, we let the user app pass it via constructor or static
  }
  
  void setPendingReferralCode(String code) {
    setState(() {
      referralCtrl.text = code.toUpperCase();
      _referralCodeFromDeepLink = code;
    });
    
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('Referral code auto-filled: $code'),
        backgroundColor: Colors.cyanAccent,
      ),
    );
  }
  
  Future<void> submit() async {
    if (_isSubmitting) return;

    final email = emailCtrl.text.trim();
    final password = passCtrl.text;
    final referralCode = referralCtrl.text.trim().toUpperCase();

    if (email.isEmpty || password.isEmpty) {
      setState(() {
        message = 'Email and password are required';
      });
      return;
    }

    setState(() {
      _isSubmitting = true;
      message = '';
    });

    try {
      final deviceId = await getOrCreateDeviceId();
      final res = isLogin
          ? await login(email, password, deviceId)
          : await register(
              email,
              password,
              deviceId,
              referralCode: referralCode.isNotEmpty ? referralCode : null,
            );

      // Rest of submit code...
    } catch (e) {
      // Handle error
    }
  }
}
```

---

## 4️⃣ Share Referral Link from App

**Add to Referrals dialog or menu:**

```dart
Future<void> _showReferralLinkDialog() async {
  try {
    final linkData = await getReferralLinkAPI();
    final referralCode = linkData['referralCode'];
    final shareText = linkData['shareText'];
    
    if (!mounted) return;
    
    await showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF0A1224),
        title: const Text(
          'Share Your Referral Link',
          style: TextStyle(color: Colors.cyanAccent),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: Colors.white.withOpacity(0.08),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Colors.cyanAccent.withOpacity(0.3)),
              ),
              child: SelectableText(
                'Code: $referralCode',
                style: const TextStyle(
                  color: Colors.cyanAccent,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
            const SizedBox(height: 10),
            const Text(
              'Share this with friends to earn rewards when they join!',
              style: TextStyle(color: Colors.white70),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: referralCode));
              if (!mounted) return;
              Navigator.pop(ctx);
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Referral code copied!')),
              );
            },
            child: const Text(
              'Copy Code',
              style: TextStyle(color: Colors.cyanAccent),
            ),
          ),
          TextButton(
            onPressed: () async {
              await Share.share(shareText);
            },
            child: const Text(
              'Share',
              style: TextStyle(color: Colors.cyanAccent),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text(
              'Close',
              style: TextStyle(color: Colors.white70),
            ),
          ),
        ],
      ),
    );
  } catch (e) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Error: $e')),
    );
  }
}
```

---

## 5️⃣ API Integration (api.dart)

Add these functions:

```dart
Future<Map<String, dynamic>> getReferralLinkAPI() async {
  final token = await getToken();
  final response = await http.get(
    Uri.parse('$baseUrl/auth/referrals/link'),
    headers: {'Authorization': 'Bearer $token'},
  );

  if (response.statusCode == 200) {
    return jsonDecode(response.body);
  }
  throw Exception(response.body);
}

Future<Map<String, dynamic>> getReferralStatsAPI() async {
  final token = await getToken();
  final response = await http.get(
    Uri.parse('$baseUrl/auth/referrals/me'),
    headers: {'Authorization': 'Bearer $token'},
  );

  if (response.statusCode == 200) {
    return jsonDecode(response.body);
  }
  throw Exception(response.body);
}
```

---

## 6️⃣ Testing Deep Links

### Android Test
```bash
adb shell am start -W -a android.intent.action.VIEW -d "https://a-network.net/join?ref=ANET5XY" com.anetwork.app
```

### iOS Test
```bash
xcrun simctl openurl booted "app://a-network/join?ref=ANET5XY"
```

### From Browser
Users can click: `https://a-network.net/join?ref=ANET5XY`

---

## 7️⃣ User Flow

1. **User A** shares their referral code (ANET5XY) or deep link via social/chat
2. **User B** clicks the link or opens the app
3. **App intercepts** the deep link via `AppLinks`
4. **Referral code** is stored in `_pendingReferralCode`
5. **Auth page** is shown with referral code auto-filled
6. **User B signs up** with the referral code
7. **Backend** sets `referred_by = User A's ID`
8. **User A** now sees User B in their referral tracker

---

## 8️⃣ Troubleshooting

### Deep link not being intercepted
- Check AndroidManifest.xml has correct intent filter
- Verify iOS Info.plist has CFBundleURLTypes
- Test with exact URL format

### Referral code not applying
- Confirm code is uppercase
- Check backend `/auth/register` receives `referralCode` in body
- Verify database `referred_by` field is updated

### AppLinks permission issues
- Android: Ensure `android:autoVerify="true"` in manifest
- iOS: Deep links automatically work if URL scheme matches

