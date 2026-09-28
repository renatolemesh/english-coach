// Menus and choices (the tests that do not need the graph).
import { describe, expect, it } from "vitest";
import {
  commandForOption,
  isList,
  languageMenu,
  levelMenu,
  mainMenu,
  OPTION_COMMANDS,
  speedMenu,
  topicMenu,
  tutorMenu,
  voiceHelp,
} from "../../src/domain/choices.js";
import { EN, PT } from "../../src/domain/texts.js";
import { parseSpeed, parseTutor, TUTORS, tutorOf } from "../../src/domain/tutors.js";

const pt = EN;

describe("menus", () => {
  it("every option id maps to a command", () => {
    const menus = [
      voiceHelp(pt),
      mainMenu(pt),
      topicMenu(pt, "travel"),
      levelMenu(pt, "B1", ""),
      tutorMenu(pt, tutorOf(null)),
      speedMenu(pt, 1.0),
    ];
    for (const choice of menus) {
      for (const option of choice.options) {
        const command = commandForOption(option.id);
        expect(command).toBeTruthy();
        expect(OPTION_COMMANDS).toContain(command?.slice(1).split(/\s+/)[0]);
      }
    }
    expect(commandForOption("tema:2")).toBe("/tema 2");
    expect(commandForOption("reset")).toBe("/reset");
    expect(commandForOption("velocidade:80")).toBe("/velocidade 80");
    for (const bad of ["", "evil", "tema:", "tema:1 x", "tema:../../x", "/reset"]) {
      expect(commandForOption(bad)).toBeNull();
    }
  });

  it.each([EN, PT])("menu limits ($lang)", (t) => {
    // WhatsApp rejects a message that breaks any of these
    const buttons = voiceHelp(t).options;
    expect(buttons.length).toBeLessThanOrEqual(3);
    expect(buttons.every((o) => o.title.length <= 20)).toBe(true);
    expect(languageMenu(t).options.every((o) => o.title.length <= 20)).toBe(true);
    const lists = [
      mainMenu(t),
      topicMenu(t, "travel"),
      levelMenu(t, "B1", ""),
      tutorMenu(t, tutorOf(null)),
      speedMenu(t, 1.0),
    ];
    for (const choice of lists) {
      expect(isList(choice)).toBe(true);
      expect(choice.options.length).toBeLessThanOrEqual(10);
      expect(choice.button.length).toBeLessThanOrEqual(20);
      for (const o of choice.options) {
        expect(o.title.length, o.title).toBeLessThanOrEqual(24);
        expect(o.description.length, o.description).toBeLessThanOrEqual(72);
      }
    }
    expect(isList(voiceHelp(t))).toBe(false);
  });

  it("tutor and speed parsing", () => {
    expect(parseTutor("George")).toBe(TUTORS.george);
    expect(parseTutor("2")).toBe(TUTORS.sarah);
    expect(parseTutor("bob")).toBeNull();
    expect(parseTutor("9")).toBeNull();
    for (const arg of ["80", "0.8", "0,8", "80%", "0.8x"]) expect(parseSpeed(arg)).toBe(0.8);
    expect(parseSpeed("0.5")).toBeNull();
    expect(parseSpeed("fast")).toBeNull();
    expect(parseSpeed("")).toBeNull(); // Number("") would be 0
    for (const t of Object.values(TUTORS)) {
      expect("ab").toContain(t.voice[0]);
      expect("fm").toContain(t.voice[1]);
    }
  });

  it("speed and tutor menus keep their order and labels", () => {
    const speeds = speedMenu(PT, 0.8);
    expect(speeds.options.map((o) => o.id)).toEqual([
      "velocidade:100",
      "velocidade:90",
      "velocidade:80",
      "velocidade:70",
    ]);
    expect(speeds.body).toBe("Velocidade atual: *0,8x*. Escolha a velocidade da fala:");
    expect(speeds.fallbackText.split("\n")[1]).toBe("/velocidade 100 - 1,0x (Normal)");
    const tutors = tutorMenu(PT, TUTORS.george ?? tutorOf(null));
    expect(tutors.options[0]).toEqual({
      id: "voz:emma",
      title: "Emma",
      description: "Sotaque britânico, voz feminina",
    });
    expect(tutors.fallbackText).toContain(
      "/voz michael - Michael: Sotaque americano, voz masculina",
    );
    expect(tutorMenu(EN, tutorOf("nobody")).body).toBe(
      "You're talking with *Sarah*. Pick another voice:", // the default tutor,
    );
    expect(topicMenu(EN, "travel").options[3]).toEqual({
      id: "tema:4",
      title: "travel",
      description: "Trips, places and plans",
    });
    expect(levelMenu(EN, "B1", "x").options.map((o) => o.id)).toContain("nivel:C2");
  });
});
