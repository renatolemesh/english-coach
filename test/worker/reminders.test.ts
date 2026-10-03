/** Reminders before WhatsApp's 24 h window closes (worker/reminders.ts). */
import { beforeEach, describe, expect, it } from "vitest";
import { defaultRuntimeConfig } from "../../src/accounts/runtime.js";
import { FakeChannel } from "../../src/adapters/channels/fake.js";
import { MemoryRepository } from "../../src/adapters/repo/memory.js";
import { StudentAccess } from "../../src/domain/accounts.js";
import { EN, formatText, PT } from "../../src/domain/texts.js";
import type { TurnLog } from "../../src/ports/repository.js";
import { type ReminderDeps, sendReminders } from "../../src/worker/reminders.js";

const CONN = "meta-main";
const PHONE = "5541999990000";
const HOUR = 3600 * 1000;
// 15:00 in São Paulo (UTC-3): inside the hours reminders may go out
const NOW = new Date("2026-10-05T18:00:00Z");

let repo: MemoryRepository;
let channel: FakeChannel;
let deps: ReminderDeps;
let userId: number;
let streak: number;
let due: number;

function setAccess(fields: Partial<StudentAccess>) {
  repo.access.set(userId, StudentAccess.parse({ user_id: userId, name: "Ana Souza", ...fields }));
}

function practiced(n: number, at: Date) {
  for (let i = 0; i < n; i++) {
    repo.turns.push([userId, { kind: "audio", level: "A2", evaluation: { score: 80 } } as TurnLog]);
    repo.turnTimes.push(at.getTime() / 1000);
  }
}

beforeEach(async () => {
  repo = new MemoryRepository();
  channel = new FakeChannel();
  streak = 0;
  due = 0;
  userId = (await repo.createStudent(CONN, PHONE, null, "Ana Souza")).user_id;
  setAccess({ level: "A2" });
  deps = {
    repo,
    config: defaultRuntimeConfig(),
    channelFor: async (id) => (id === CONN ? channel : null),
    streakOf: async () => streak,
    dueReviews: async () => due,
  };
});

describe("reminders", () => {
  it("one nudge 20-23 h after the last message, in the student's language", async () => {
    await repo.touch(userId, new Date(NOW.getTime() - 21 * HOUR), CONN, PHONE);
    streak = 4;
    expect(await sendReminders(deps, NOW)).toBe(1);
    expect(channel.sent).toHaveLength(1);
    const [sent] = channel.sent;
    expect(sent?.kind).toBe("choice");
    expect(sent?.to).toBe(PHONE);
    const body = formatText(PT.reminder, {
      name: " Ana",
      done: 0,
      goal: 5,
      extra: formatText(PT.reminderStreak, { n: 4 }),
    });
    expect(sent?.text).toBe(`${body} [resume aula lembretes:off]`);
    // the same window never gets a second one
    expect(await sendReminders(deps, new Date(NOW.getTime() + HOUR))).toBe(0);
  });

  it("comes back only after the student writes again", async () => {
    await repo.touch(userId, new Date(NOW.getTime() - 21 * HOUR), CONN, PHONE);
    await sendReminders(deps, NOW);
    await repo.touch(userId, new Date(NOW.getTime() + HOUR), CONN, PHONE); // tapped a button
    expect(await sendReminders(deps, new Date(NOW.getTime() + 22 * HOUR))).toBe(1);
  });

  it("not too early, not after the window could close", async () => {
    for (const hours of [19, 23.5, 30]) {
      await repo.touch(userId, new Date(NOW.getTime() - hours * HOUR), CONN, PHONE);
      expect(await sendReminders(deps, NOW)).toBe(0);
    }
  });

  it("never at night (local time)", async () => {
    const night = new Date("2026-10-06T02:30:00Z"); // 23:30 in São Paulo
    await repo.touch(userId, new Date(night.getTime() - 21 * HOUR), CONN, PHONE);
    expect(await sendReminders(deps, night)).toBe(0);
    expect(repo.reminded.size).toBe(0); // still due in the morning, if the window allows
  });

  it("nothing when the goal is done, reminders are off, or the plan ended", async () => {
    await repo.touch(userId, new Date(NOW.getTime() - 21 * HOUR), CONN, PHONE);
    setAccess({ level: "A2", daily_goal: 2 });
    practiced(2, new Date(NOW.getTime() - 2 * HOUR)); // after midnight: today's goal is done
    expect(await sendReminders(deps, NOW)).toBe(0);

    repo.reminded.clear();
    setAccess({ level: "A2", reminders: false });
    expect(await sendReminders(deps, NOW)).toBe(0);

    setAccess({ level: "A2", plan_ends_at: new Date(NOW.getTime() - HOUR) });
    expect(await sendReminders(deps, NOW)).toBe(0);
    expect(channel.sent).toEqual([]);
  });

  it("English from B1 without a choice; reviews waiting when there is no streak", async () => {
    setAccess({ level: "B1", name: null });
    due = 7;
    await repo.touch(userId, new Date(NOW.getTime() - 22 * HOUR), CONN, PHONE);
    expect(await sendReminders(deps, NOW)).toBe(1);
    const body = formatText(EN.reminder, {
      name: "",
      done: 0,
      goal: 5,
      extra: formatText(EN.reminderDue, { n: 7 }),
    });
    expect(channel.sent[0]?.text?.startsWith(body)).toBe(true);
  });
});
