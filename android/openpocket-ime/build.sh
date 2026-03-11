#!/bin/bash
# Build openpocket-ime.apk from source using raw Android SDK tools.
# Requires: ANDROID_SDK_ROOT (or ANDROID_HOME or ~/Library/Android/sdk),
#           build-tools, platforms/android-*, and a JDK with javac + keytool.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"

# ---------- locate platform jar ----------
PLATFORM_JAR=""
for d in "$SDK"/platforms/android-*; do
  if [ -f "$d/android.jar" ]; then
    PLATFORM_JAR="$d/android.jar"
  fi
done
if [ -z "$PLATFORM_JAR" ]; then
  echo "ERROR: android.jar not found under $SDK/platforms/" >&2
  exit 1
fi
echo "Platform JAR: $PLATFORM_JAR"

# ---------- locate build-tools ----------
BUILD_TOOLS=""
for d in "$SDK"/build-tools/*; do
  [ -d "$d" ] && BUILD_TOOLS="$d"
done
if [ -z "$BUILD_TOOLS" ] || [ ! -f "$BUILD_TOOLS/aapt2" ]; then
  echo "ERROR: build-tools not found. Install with:" >&2
  echo "  sdkmanager 'build-tools;36.0.0'" >&2
  exit 1
fi
echo "Build tools: $BUILD_TOOLS"

AAPT2="$BUILD_TOOLS/aapt2"
D8="$BUILD_TOOLS/d8"
ZIPALIGN="$BUILD_TOOLS/zipalign"
APKSIGNER="$BUILD_TOOLS/apksigner"

# ---------- clean ----------
BUILD="build"
rm -rf "$BUILD"
mkdir -p "$BUILD/compiled" "$BUILD/classes" "$BUILD/dex"

# ---------- 1. compile resources ----------
echo "[1/6] Compile resources"
"$AAPT2" compile --dir src/main/res -o "$BUILD/compiled/"

# ---------- 2. link into base APK ----------
echo "[2/6] Link resources"
"$AAPT2" link \
  --manifest src/main/AndroidManifest.xml \
  -I "$PLATFORM_JAR" \
  -o "$BUILD/base.apk" \
  --auto-add-overlay \
  "$BUILD/compiled/"*.flat

# ---------- 3. compile Java ----------
echo "[3/6] Compile Java"
javac \
  --release 17 \
  -classpath "$PLATFORM_JAR" \
  -d "$BUILD/classes" \
  src/main/java/ai/openpocket/ime/*.java

# ---------- 4. dex ----------
echo "[4/6] Create DEX"
"$D8" \
  --output "$BUILD/dex/" \
  --lib "$PLATFORM_JAR" \
  --min-api 21 \
  "$BUILD/classes/ai/openpocket/ime/"*.class

# ---------- 5. merge dex into APK ----------
echo "[5/6] Package APK"
cp "$BUILD/base.apk" "$BUILD/unsigned.apk"
(cd "$BUILD/dex" && zip -u ../unsigned.apk classes.dex)

# ---------- 6. align + sign ----------
echo "[6/6] Align & sign"
"$ZIPALIGN" -f 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"

DEBUG_KS="$HOME/.android/debug.keystore"
if [ ! -f "$DEBUG_KS" ]; then
  mkdir -p "$HOME/.android"
  keytool -genkey -v \
    -keystore "$DEBUG_KS" \
    -storepass android -alias androiddebugkey -keypass android \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US"
fi

"$APKSIGNER" sign \
  --ks "$DEBUG_KS" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out "$BUILD/openpocket-ime.apk" \
  "$BUILD/aligned.apk"

# ---------- copy to assets ----------
ASSETS_DIR="$SCRIPT_DIR/../../assets/android"
mkdir -p "$ASSETS_DIR"
cp "$BUILD/openpocket-ime.apk" "$ASSETS_DIR/openpocket-ime.apk"

SIZE=$(wc -c < "$BUILD/openpocket-ime.apk" | tr -d ' ')
echo ""
echo "SUCCESS: $BUILD/openpocket-ime.apk ($SIZE bytes)"
echo "Copied to: $ASSETS_DIR/openpocket-ime.apk"
