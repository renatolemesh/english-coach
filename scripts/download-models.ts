/** Build time: download Kokoro (with the tutors' voices) and the local embedding model into
 * MODELS_DIR, the transformers.js cache the worker reads (it runs with remote models off).
 * Voices are kept literal here so the build step does not depend on the source tree. */
import { env, pipeline } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

env.cacheDir = process.env.MODELS_DIR ?? "/opt/models";
const KOKORO = process.env.KOKORO_MODEL ?? "onnx-community/Kokoro-82M-v1.0-ONNX";
const EMBEDDINGS = process.env.LOCAL_EMBEDDING_MODEL ?? "Xenova/bge-small-en-v1.5";
const VOICES = ["bf_emma", "af_heart", "bm_george", "am_michael"];

const tts = await KokoroTTS.from_pretrained(KOKORO, { dtype: "fp32", device: "cpu" });
for (const voice of VOICES) {
  await tts.generate("Hello.", { voice: voice as never });
  console.log("voice ready", voice);
}
const embed = await pipeline("feature-extraction", EMBEDDINGS, { dtype: "fp32" });
await embed("warm up", { pooling: "cls", normalize: true });
console.log("embeddings ready", EMBEDDINGS);
