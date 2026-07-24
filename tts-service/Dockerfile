# Python TTS service — bundles the espeak-ng binary (and ffmpeg for optional
# MP3 output) with the app. Build context is this directory (tts-service/).
FROM python:3.11-slim

# System deps: espeak-ng provides the voices + the shared lib phonemizer loads;
# ffmpeg is used for optional MP3 TTS output; libgomp1 is required by
# ctranslate2 (the faster-whisper STT runtime).
RUN apt-get update \
    && apt-get install -y --no-install-recommends espeak-ng ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# phonemizer finds the shared library via this on Debian/Ubuntu.
ENV PHONEMIZER_ESPEAK_LIBRARY=/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1
ENV TTS_AUDIO_FORMAT=wav

EXPOSE 8081
# Bind the port the platform injects ($PORT, e.g. Render), falling back to 8081
# for local runs. Shell form so ${PORT} is expanded at container start. Without
# this the app listens on 8081 while Render health-checks $PORT → the router
# reports "no-server" and the service is unreachable.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8081}"]
