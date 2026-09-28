/** The real media adapters (worker only): whisper.cpp, Kokoro and Chromium, loaded once. */
import path from "node:path";
import type { Settings } from "../config.js";
import type { Media } from "../container.js";
import { getLogger } from "../logging.js";
import type { Cache } from "../ports/cache.js";
import { FfmpegAudio } from "./audio/ffmpeg.js";
import { CardBuilder } from "./image/card.js";
import { PlaywrightRenderer } from "./image/playwright.js";
import { WhisperCppSTT } from "./stt/whisper-cpp.js";
import { KokoroTTS } from "./tts/kokoro.js";

const log = getLogger("coach.adapters.media");

export async function buildMedia(settings: Settings, cache: Cache): Promise<Media> {
  const audio = new FfmpegAudio();
  const tts = new KokoroTTS(settings, audio, cache);
  const image = new PlaywrightRenderer(new CardBuilder(path.join(settings.templatesDir)));
  return {
    stt: new WhisperCppSTT(settings, audio, cache),
    tts,
    image,
    /** Load the models and open the browser before the first message. */
    async warmUp() {
      const start = performance.now();
      await Promise.all([tts.load(), image.start()]);
      log.info("media_ready", { ms: Math.round(performance.now() - start) });
    },
    close: () => image.close(),
  };
}
