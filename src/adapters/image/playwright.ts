/**
 * ImageRenderer: HTML card -> PNG with one headless Chromium reused across messages. Each
 * render uses a fresh context with JavaScript disabled and every network request aborted: the
 * page is self-contained (inline CSS, base64 fonts), so nothing can be fetched even if some
 * text slipped through escaping.
 */
import type { Browser } from "playwright";
import type { Evaluation } from "../../domain/evaluation.js";
import { getLogger } from "../../logging.js";
import type { ImageRenderer } from "../../ports/media.js";
import type { CardBuilder } from "./card.js";

const log = getLogger("coach.adapters.image.playwright");
export const WIDTH = 1080;

export class PlaywrightRenderer implements ImageRenderer {
  private browser: Promise<Browser> | null = null;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly cards: CardBuilder,
    private readonly maxConcurrency = 2,
  ) {}

  /** Idempotent. Relaunches a crashed browser. */
  async start(): Promise<Browser> {
    const current = this.browser ? await this.browser.catch(() => null) : null;
    if (current?.isConnected()) return current;
    this.browser = (async () => {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch();
      log.info("image_browser_started");
      return browser;
    })();
    return this.browser;
  }

  async close(): Promise<void> {
    const browser = this.browser ? await this.browser.catch(() => null) : null;
    this.browser = null;
    await browser?.close().catch(() => undefined);
  }

  render(
    evaluation: Evaluation,
    topic: string | null = null,
    level: string | null = null,
  ): Promise<Buffer> {
    return this.screenshotHtml(this.cards.html(evaluation, topic, level));
  }

  async screenshotHtml(html: string): Promise<Buffer> {
    const browser = await this.start(); // relaunches if the browser crashed
    await this.acquire();
    try {
      const context = await browser.newContext({
        viewport: { width: WIDTH, height: 800 },
        deviceScaleFactor: 1,
        javaScriptEnabled: false,
        offline: true,
      });
      try {
        const page = await context.newPage();
        await page.route("**/*", (route) => route.abort());
        await page.setContent(html, { waitUntil: "load" });
        return await page.screenshot({ fullPage: true, type: "png" });
      } finally {
        await context.close();
      }
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}
