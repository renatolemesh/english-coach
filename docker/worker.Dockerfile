# Worker: Node + ffmpeg + whisper.cpp + Chromium + Kokoro. Build context: the repo root.
FROM node:22-bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends git cmake g++ make ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Built for this server's CPU (GGML_NATIVE): the image runs where it is built.
RUN git clone --depth 1 --branch v1.9.4 https://github.com/ggml-org/whisper.cpp /src \
    && cmake -S /src -B /build -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /build -j3 --target whisper-cli

FROM node:22-bookworm-slim AS models
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/models \
    && curl -fsSL -o /opt/models/ggml-small.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin \
    && curl -fsSL -o /opt/models/ggml-small.en-q8_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q8_0.bin \
    && curl -fsSL -o /opt/models/ggml-silero-v6.2.0.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright MODELS_DIR=/opt/models
RUN npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=models /opt/models /opt/models
COPY scripts/download-models.ts ./scripts/download-models.ts
RUN npx tsx scripts/download-models.ts
ENV WHISPER_MODEL_PATH=/opt/models/ggml-small.en-q8_0.bin \
    WHISPER_VAD_MODEL_PATH=/opt/models/ggml-silero-v6.2.0.bin \
    SAYBEST_ROOT=/app
COPY tsconfig.json ./
COPY prompts prompts
COPY schemas schemas
COPY data data
COPY templates templates
COPY scripts scripts
COPY src src
USER node
CMD ["npx", "tsx", "src/worker/main.ts"]
