#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
BUILD_TOOLS_VERSION="${BUILD_TOOLS_VERSION:-34.0.0}"
PLATFORM_API="${PLATFORM_API:-34}"

AAPT="$SDK_ROOT/build-tools/$BUILD_TOOLS_VERSION/aapt"
D8="$SDK_ROOT/build-tools/$BUILD_TOOLS_VERSION/d8"
ZIPALIGN="$SDK_ROOT/build-tools/$BUILD_TOOLS_VERSION/zipalign"
APKSIGNER="$SDK_ROOT/build-tools/$BUILD_TOOLS_VERSION/apksigner"
ANDROID_JAR="$SDK_ROOT/platforms/android-$PLATFORM_API/android.jar"
OUT_DIR="$SCRIPT_DIR/build"

java_major_from_bin() {
  local bin="$1"
  "$bin" -version 2>&1 | awk -F'[\".]' '/version/ { if ($2 == "1") print $3; else print $2; exit }'
}

current_java_major=0
if command -v java >/dev/null 2>&1; then
  current_java_major="$(java_major_from_bin "$(command -v java)" 2>/dev/null || echo 0)"
fi

if [[ "$current_java_major" -lt 11 ]]; then
  if JAVA_CANDIDATE="$(/usr/libexec/java_home -v 21 2>/dev/null)"; then
    export JAVA_HOME="$JAVA_CANDIDATE"
  elif JAVA_CANDIDATE="$(/usr/libexec/java_home -v 17 2>/dev/null)"; then
    export JAVA_HOME="$JAVA_CANDIDATE"
  fi
fi
if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi
JAVAC="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
if [[ ! -x "$JAVAC" ]]; then
  JAVAC="$(command -v javac || true)"
fi
if [[ -z "$JAVAC" ]]; then
  echo "javac not found" >&2
  exit 1
fi

for bin in "$AAPT" "$D8" "$ZIPALIGN" "$APKSIGNER"; do
  if [[ ! -x "$bin" ]]; then
    echo "Missing tool: $bin" >&2
    exit 1
  fi
done
if [[ ! -f "$ANDROID_JAR" ]]; then
  echo "Missing android.jar: $ANDROID_JAR" >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/generated" "$OUT_DIR/classes" "$OUT_DIR/dex"

"$AAPT" package -f -m \
  -M "$SCRIPT_DIR/AndroidManifest.xml" \
  -S "$SCRIPT_DIR/res" \
  -I "$ANDROID_JAR" \
  -J "$OUT_DIR/generated"

JAVA_SOURCES=()
while IFS= read -r source; do
  JAVA_SOURCES+=("$source")
done < <(find "$SCRIPT_DIR/src" "$OUT_DIR/generated" -name "*.java" | sort)

"$JAVAC" -source 1.8 -target 1.8 \
  -bootclasspath "$ANDROID_JAR" \
  -classpath "$ANDROID_JAR" \
  -d "$OUT_DIR/classes" \
  "${JAVA_SOURCES[@]}"

CLASSES_JAR="$OUT_DIR/classes.jar"
jar cf "$CLASSES_JAR" -C "$OUT_DIR/classes" .

"$D8" \
  --lib "$ANDROID_JAR" \
  --output "$OUT_DIR/dex" \
  "$CLASSES_JAR"
cp "$OUT_DIR/dex/classes.dex" "$OUT_DIR/classes.dex"

"$AAPT" package -f \
  -M "$SCRIPT_DIR/AndroidManifest.xml" \
  -S "$SCRIPT_DIR/res" \
  -I "$ANDROID_JAR" \
  -F "$OUT_DIR/unsigned.apk"

(
  cd "$OUT_DIR"
  "$AAPT" add unsigned.apk classes.dex >/dev/null
)

"$ZIPALIGN" -f 4 "$OUT_DIR/unsigned.apk" "$OUT_DIR/aligned.apk"

KEYSTORE="$HOME/.android/debug.keystore"
if [[ ! -f "$KEYSTORE" ]]; then
  mkdir -p "$HOME/.android"
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" \
    -storepass android \
    -keypass android \
    -alias androiddebugkey \
    -dname "CN=Android Debug,O=Android,C=US" \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 >/dev/null 2>&1
fi

"$APKSIGNER" sign \
  --ks "$KEYSTORE" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out "$OUT_DIR/input-lab-debug.apk" \
  "$OUT_DIR/aligned.apk"

echo "$OUT_DIR/input-lab-debug.apk"
