FROM --platform=linux/amd64 node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  unzip \
  wget \
  openjdk-17-jdk \
  libnss3 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxi6 \
  libxtst6 \
  libxrandr2 \
  libxkbcommon0 \
  libxfixes3 \
  libglib2.0-0 \
  libgtk-3-0 \
  libdbus-1-3 \
  libfontconfig1 \
  libasound2 \
  libpulse0 \
  libstdc++6 \
  libgl1 \
  && rm -rf /var/lib/apt/lists/*

ARG ANDROID_CMDLINE_TOOLS_ZIP=commandlinetools-linux-11076708_latest.zip
RUN mkdir -p /opt/android-sdk/cmdline-tools \
  && wget -q "https://dl.google.com/android/repository/${ANDROID_CMDLINE_TOOLS_ZIP}" -O /tmp/cmdline-tools.zip \
  && unzip -q /tmp/cmdline-tools.zip -d /tmp \
  && mv /tmp/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
  && rm -rf /tmp/cmdline-tools.zip /tmp/cmdline-tools

RUN yes | sdkmanager --sdk_root=/opt/android-sdk --licenses >/dev/null
RUN sdkmanager --sdk_root=/opt/android-sdk \
  "platform-tools" \
  "emulator" \
  "platforms;android-34" \
  "system-images;android-34;google_apis_playstore;x86_64"
RUN echo "no" | avdmanager create avd --force -n OpenPocket_AVD -k "system-images;android-34;google_apis_playstore;x86_64"

WORKDIR /workspace

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY test ./test
COPY docs ./docs
COPY openpocket ./openpocket
COPY openpocket.config.example.json ./openpocket.config.example.json
COPY README.md ./README.md
COPY LICENSE ./LICENSE
COPY docker/e2e/entrypoint.sh /usr/local/bin/openpocket-e2e

RUN chmod +x /workspace/openpocket \
  && chmod +x /usr/local/bin/openpocket-e2e

CMD ["openpocket-e2e"]
