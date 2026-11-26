---
name: sec-mobile
description: Zero-trust audit of Mobile applications (Expo, React Native, Android, iOS) covering secure storage, clipboard leakage, deep links, permissions, biometrics, certificate pinning, offline storage, root/jailbreak detection, and mobile API security.
---

# Security Audit: Mobile Applications (Expo / React Native / Android / iOS)

Inspect mobile codebases, native manifests (`AndroidManifest.xml`, `Info.plist`), build configs, and network layers assuming physical device loss, malicious peer apps, and MitM proxies.

## Mobile Security Checklist

- **Storage & Data Leakage:** Secrets/tokens stored in `AsyncStorage` / `SharedPreferences` / `UserDefaults` instead of Keychain / EncryptedSharedPreferences (`expo-secure-store`); unencrypted SQLite/Realm offline caches; sensitive values copied to system clipboard; automatic OS screenshot/app-switcher caching of sensitive screens.
- **IPC, Deep Links & Intents:** Unvalidated Universal Links / App Links / custom URL schemes (`myapp://`) leading to open redirect, token theft, or privileged action invocation; exported Android Activities/Services/Receivers/ContentProviders without permissions.
- **Permissions & Biometrics:** Over-broad runtime permissions (location, camera, contacts, storage); client-side-only biometric checks (`LocalAuthentication`) bypassable via Frida/hooking without cryptographic key-unlock binding.
- **Network & Tamper Resistance:** Missing TLS certificate pinning for high-value endpoints; cleartext HTTP traffic (`usesCleartextTraffic=true`, ATS exceptions); missing root/jailbreak/debugger detection where required by threat model; hardcoded API keys or bundle secrets extractable from `.apk`/`.ipa`.

## Finding Requirements

Report every finding with: Severity, Why vulnerable, Exploit scenario, Business impact, OWASP MASVS & CWE mapping (MASVS-STORAGE, MASVS-NETWORK, MASVS-PLATFORM, CWE-312, CWE-926), CVSS estimate, PoC, Affected files/functions, and Secure implementation example.
