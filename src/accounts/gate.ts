/**
 * Who may talk to the bot, decided before the conversation graph runs (no LLM call).
 *
 * 1. "ATIVAR 123456" / "SENHA 123456": a code from the website (accounts/verification.ts).
 *    Signup creates the account on the WhatsApp id that sent it, then the turn continues as
 *    /start (welcome + first question). Reset marks the site's token as confirmed.
 * 2. Unknown number: `unknown_numbers=reject` answers with the signup link; `trial` creates a
 *    trial account and lets the turn run.
 * 3. Blocked student or ended plan: a fixed message. A plan with a next plan (the 30-day
 *    trial) moves the student there instead, with a notice, and the turn runs.
 * Fixed answers go out at most once a day per number (REPLY_ONCE_S), so a loop or a flood
 * never gets a stream of replies.
 */
import { expired, type StudentAccess, uiLangOf } from "../domain/accounts.js";
import type { IncomingMessage } from "../domain/messages.js";
import { formatText, type Texts, textsFor } from "../domain/texts.js";
import { getLogger } from "../logging.js";
import type { Cache } from "../ports/cache.js";
import type { ChatChannel } from "../ports/channel.js";
import type { TurnRepository } from "../ports/repository.js";
import { samePhone } from "./phones.js";
import type { RuntimeConfig } from "./runtime.js";
import * as verification from "./verification.js";

const log = getLogger("coach.accounts.gate");
export const REPLY_ONCE_S = 24 * 3600;

export interface Admission {
  access: StudentAccess | null; // null: the turn does not run
  start: boolean; // a fresh signup: run the turn as /start
}

const refused: Admission = { access: null, start: false };

export class AccountGate {
  constructor(
    private readonly repo: TurnRepository,
    private readonly cache: Cache,
    private readonly panelUrl: string, // https://<domain>/panel
  ) {}

  async admit(
    msg: IncomingMessage,
    connectionId: string,
    channel: ChatChannel,
    config: RuntimeConfig,
  ): Promise<Admission> {
    const phone = msg.from;
    let access = await this.repo.studentAccess(connectionId, phone);
    const texts = textsFor(uiLangOf(access?.ui_lang, access?.level, config.default_ui_lang));
    const code = msg.type === "text" ? verification.parse(msg.text ?? "") : null;
    if (code) return this.code(code, msg, connectionId, channel, config, texts, access);
    if (access === null) {
      if (config.unknown_numbers === "trial") {
        access = await this.repo.createStudent(connectionId, phone, config.trial_plan);
        log.info("student_created", { reason: "trial_policy", user_id: access.user_id });
        return { access, start: false };
      }
      const url = `${this.panelUrl}/signup`;
      await this.once(
        channel,
        phone,
        "unknown",
        formatText(texts.notEnrolled, { signup_url: url }),
      );
      return refused;
    }
    if (access.status === "blocked") {
      const text = formatText(texts.accountBlocked, { contact: config.contact_text }).trim();
      await this.once(channel, phone, "blocked", text);
      return refused;
    }
    if (expired(access)) {
      const moved = await this.repo.advancePlan(access.user_id); // the trial becomes the free plan
      if (moved && !expired(moved.access)) {
        await this.planChanged(channel, phone, texts, moved.ended, moved.access);
        return { access: moved.access, start: false };
      }
      const text = formatText(texts.planExpired, {
        contact: config.contact_text,
        panel_url: this.panelUrl,
      });
      await this.once(channel, phone, "expired", text.split(/\s+/).filter(Boolean).join(" "));
      return refused;
    }
    return { access, start: false };
  }

  private async code(
    [kind, digits]: [verification.Kind, string],
    msg: IncomingMessage,
    connectionId: string,
    channel: ChatChannel,
    config: RuntimeConfig,
    texts: Texts,
    access: StudentAccess | null,
  ): Promise<Admission> {
    const pending = await verification.claim(this.cache, kind, digits);
    const phone = msg.from; // the address: a phone on WhatsApp, the chat id on Telegram
    if (!pending) {
      await channel.sendText(phone, texts.codeUnknown);
      return refused;
    }
    const lang = textsFor(pending.lang);
    if (kind === "link") return this.link(pending, phone, connectionId, channel, lang);
    const wrongAccount = kind === "reset" && pending.user_id !== (access?.user_id ?? null);
    // without phones (Telegram) the code, shown only on the site, is the proof
    if ((channel.phones && !samePhone(pending.phone, phone)) || wrongAccount) {
      log.warning("verification_wrong_phone", { kind });
      await verification.setStatus(this.cache, pending.token, { status: "wrong_phone" });
      await channel.sendText(phone, lang.codeWrongPhone);
      return refused;
    }
    if (kind === "reset") {
      await verification.setStatus(this.cache, pending.token, {
        status: "done",
        user_id: pending.user_id,
      });
      await channel.sendText(phone, lang.resetConfirmed);
      return refused;
    }
    if (!channel.phones && access === null && (await this.repo.studentIdByPhone(pending.phone))) {
      // that phone has an account: link this chat from the panel instead (an unchecked phone
      // must never open someone else's account)
      await verification.setStatus(this.cache, pending.token, { status: "phone_taken" });
      await channel.sendText(phone, lang.phoneTaken);
      return refused;
    }
    const created = await this.repo.createStudent(
      connectionId,
      phone,
      access === null ? config.trial_plan : null,
      pending.name,
      pending.password_hash,
      pending.lang === "en" || pending.lang === "pt" ? pending.lang : null, // "auto": by level
      channel.phones ? null : pending.phone,
    );
    await verification.setStatus(this.cache, pending.token, {
      status: "done",
      user_id: created.user_id,
    });
    log.info("student_signed_up", { user_id: created.user_id });
    return { access: created, start: true };
  }

  /** "VINCULAR 123456" (Telegram: the panel's "Conectar Telegram" link): this chat joins the
   * logged-in student's account. */
  private async link(
    pending: verification.Pending,
    address: string,
    connectionId: string,
    channel: ChatChannel,
    lang: Texts,
  ): Promise<Admission> {
    const userId = pending.user_id;
    const linked = userId !== null && (await this.repo.linkIdentity(userId, connectionId, address));
    await verification.setStatus(this.cache, pending.token, {
      status: linked ? "done" : "expired",
      user_id: userId,
    });
    log.info("identity_linked", { user_id: userId, connection_id: connectionId, linked });
    await channel.sendText(address, linked ? lang.linkDone : lang.linkTaken);
    return refused;
  }

  private async planChanged(
    channel: ChatChannel,
    phone: string,
    texts: Texts,
    ended: string,
    access: StudentAccess,
  ) {
    const n = access.messages_per_day;
    const limit = n ? formatText(texts.planLimit, { n }) : texts.planUnlimited;
    log.info("plan_changed", { user_id: access.user_id, plan: access.plan_name });
    try {
      await channel.sendText(
        phone,
        formatText(texts.planChanged, {
          old: ended,
          plan: access.plan_name ?? "",
          limit,
          panel_url: this.panelUrl,
        }),
      );
    } catch (exc) {
      log.warning("send_failed", { kind: "plan_changed", error: String(exc) }); // the turn goes on
    }
  }

  private async once(channel: ChatChannel, phone: string, what: string, text: string) {
    if (await this.cache.setIfAbsent(`gate:${what}:${phone}`, Buffer.from("1"), REPLY_ONCE_S)) {
      await channel.sendText(phone, text);
    }
    log.info("gate_refused", { reason: what });
  }
}
