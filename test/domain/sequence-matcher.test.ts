import { describe, expect, it } from "vitest";
import { type Match, type Opcode, SequenceMatcher } from "../../src/domain/sequence-matcher.js";

interface Case {
  a: string[];
  b: string[];
  blocks: Match[];
  opcodes: Opcode[];
  ratio: number;
}

// Reference outputs of difflib's SequenceMatcher (no junk, no autojunk): the matcher must
// give the same answers.
// biome-ignore format: generated fixture
const CASES: Case[] =
[
  {"a": [], "b": [], "blocks": [[0, 0, 0]], "opcodes": [], "ratio": 1.0},
  {"a": [], "b": ["a", "b", "c"], "blocks": [[0, 3, 0]], "opcodes": [["insert", 0, 0, 0, 3]], "ratio": 0.0},
  {"a": ["a", "b", "c"], "b": [], "blocks": [[3, 0, 0]], "opcodes": [["delete", 0, 3, 0, 0]], "ratio": 0.0},
  {"a": ["a"], "b": ["a"], "blocks": [[0, 0, 1], [1, 1, 0]], "opcodes": [["equal", 0, 1, 0, 1]], "ratio": 1.0},
  {"a": ["a"], "b": ["b"], "blocks": [[1, 1, 0]], "opcodes": [["replace", 0, 1, 0, 1]], "ratio": 0.0},
  {"a": ["a", "b", "c", "d"], "b": ["a", "b", "c", "d"], "blocks": [[0, 0, 4], [4, 4, 0]], "opcodes": [["equal", 0, 4, 0, 4]], "ratio": 1.0},
  {"a": ["a", "b", "c", "d"], "b": ["d", "c", "b", "a"], "blocks": [[0, 3, 1], [4, 4, 0]], "opcodes": [["insert", 0, 0, 0, 3], ["equal", 0, 1, 3, 4], ["delete", 1, 4, 4, 4]], "ratio": 0.25},
  {"a": ["a", "a", "a", "a"], "b": ["a", "a"], "blocks": [[0, 0, 2], [4, 2, 0]], "opcodes": [["equal", 0, 2, 0, 2], ["delete", 2, 4, 2, 2]], "ratio": 0.6666666666666666},
  {"a": ["a", "a"], "b": ["a", "a", "a", "a"], "blocks": [[0, 0, 2], [2, 4, 0]], "opcodes": [["equal", 0, 2, 0, 2], ["insert", 2, 2, 2, 4]], "ratio": 0.6666666666666666},
  {"a": ["a", "b", "a", "b", "a", "b"], "b": ["b", "a", "b", "a"], "blocks": [[1, 0, 4], [6, 4, 0]], "opcodes": [["delete", 0, 1, 0, 0], ["equal", 1, 5, 0, 4], ["delete", 5, 6, 4, 4]], "ratio": 0.8},
  {"a": ["x", "a", "b", "x", "a", "b"], "b": ["a", "b", "x"], "blocks": [[1, 0, 3], [6, 3, 0]], "opcodes": [["delete", 0, 1, 0, 0], ["equal", 1, 4, 0, 3], ["delete", 4, 6, 3, 3]], "ratio": 0.6666666666666666},
  {"a": ["the", "the", "the", "cat"], "b": ["the", "cat", "the"], "blocks": [[2, 0, 2], [4, 3, 0]], "opcodes": [["delete", 0, 2, 0, 0], ["equal", 2, 4, 0, 2], ["insert", 4, 4, 2, 3]], "ratio": 0.5714285714285714},
  {"a": ["a", "b", "c", "a", "b", "c", "a", "b", "c"], "b": ["c", "b", "a", "c", "b", "a"], "blocks": [[0, 2, 1], [1, 4, 1], [3, 5, 1], [9, 6, 0]], "opcodes": [["insert", 0, 0, 0, 2], ["equal", 0, 1, 2, 3], ["insert", 1, 1, 3, 4], ["equal", 1, 2, 4, 5], ["delete", 2, 3, 5, 5], ["equal", 3, 4, 5, 6], ["delete", 4, 9, 6, 6]], "ratio": 0.4},
  {"a": ["one", "two", "three", "four", "five"], "b": ["one", "three", "five"], "blocks": [[0, 0, 1], [2, 1, 1], [4, 2, 1], [5, 3, 0]], "opcodes": [["equal", 0, 1, 0, 1], ["delete", 1, 2, 1, 1], ["equal", 2, 3, 1, 2], ["delete", 3, 4, 2, 2], ["equal", 4, 5, 2, 3]], "ratio": 0.75},
  {"a": ["one", "three", "five"], "b": ["one", "two", "three", "four", "five"], "blocks": [[0, 0, 1], [1, 2, 1], [2, 4, 1], [3, 5, 0]], "opcodes": [["equal", 0, 1, 0, 1], ["insert", 1, 1, 1, 2], ["equal", 1, 2, 2, 3], ["insert", 2, 2, 3, 4], ["equal", 2, 3, 4, 5]], "ratio": 0.75},
  {"a": ["a", "b", "c", "d", "e", "f", "g"], "b": ["a", "x", "c", "y", "e", "z", "g"], "blocks": [[0, 0, 1], [2, 2, 1], [4, 4, 1], [6, 6, 1], [7, 7, 0]], "opcodes": [["equal", 0, 1, 0, 1], ["replace", 1, 2, 1, 2], ["equal", 2, 3, 2, 3], ["replace", 3, 4, 3, 4], ["equal", 4, 5, 4, 5], ["replace", 5, 6, 5, 6], ["equal", 6, 7, 6, 7]], "ratio": 0.5714285714285714},
  {"a": ["i", "went", "to", "the", "the", "beach", "in", "sao", "paulo", "it", "was", "amazing"], "b": ["i", "went", "to", "the", "beach", "in", "sao", "paulo", "it", "was", "amazing"], "blocks": [[0, 0, 3], [4, 3, 8], [12, 11, 0]], "opcodes": [["equal", 0, 3, 0, 3], ["delete", 3, 4, 3, 3], ["equal", 4, 12, 3, 11]], "ratio": 0.9565217391304348},
  {"a": ["i", "am", "work", "in", "a", "bank", "since", "five", "years", "and", "i", "like", "very", "much", "my", "job"], "b": ["i", "have", "worked", "in", "a", "bank", "for", "five", "years", "and", "i", "really", "like", "my", "job"], "blocks": [[0, 0, 1], [3, 3, 3], [7, 7, 4], [11, 12, 1], [14, 13, 2], [16, 15, 0]], "opcodes": [["equal", 0, 1, 0, 1], ["replace", 1, 3, 1, 3], ["equal", 3, 6, 3, 6], ["replace", 6, 7, 6, 7], ["equal", 7, 11, 7, 11], ["insert", 11, 11, 11, 12], ["equal", 11, 12, 12, 13], ["delete", 12, 14, 13, 13], ["equal", 14, 16, 13, 15]], "ratio": 0.7096774193548387},
  {"a": ["i", "pretend", "to", "travel", "to", "europe", "next", "year", "with", "my", "wife"], "b": ["i", "intend", "to", "travel", "to", "europe", "next", "year", "with", "my", "wife"], "blocks": [[0, 0, 1], [2, 2, 9], [11, 11, 0]], "opcodes": [["equal", 0, 1, 0, 1], ["replace", 1, 2, 1, 2], ["equal", 2, 11, 2, 11]], "ratio": 0.9090909090909091},
  {"a": ["yesterday", "i", "go", "to", "the", "big", "market", "near", "my", "house", "and", "i", "buyed", "some", "apples"], "b": ["yesterday", "i", "went", "to", "the", "big", "market", "near", "my", "house", "and", "i", "bought", "some", "apples"], "blocks": [[0, 0, 2], [3, 3, 9], [13, 13, 2], [15, 15, 0]], "opcodes": [["equal", 0, 2, 0, 2], ["replace", 2, 3, 2, 3], ["equal", 3, 12, 3, 12], ["replace", 12, 13, 12, 13], ["equal", 13, 15, 13, 15]], "ratio": 0.8666666666666667},
  {"a": ["in", "my", "city", "the", "people", "is", "friendly", "and", "there", "have", "many", "parks"], "b": ["in", "my", "city", "the", "people", "are", "friendly", "and", "there", "are", "many", "parks"], "blocks": [[0, 0, 5], [6, 6, 3], [10, 10, 2], [12, 12, 0]], "opcodes": [["equal", 0, 5, 0, 5], ["replace", 5, 6, 5, 6], ["equal", 6, 9, 6, 9], ["replace", 9, 10, 9, 10], ["equal", 10, 12, 10, 12]], "ratio": 0.8333333333333334},
  {"a": ["when", "i", "was", "child", "i", "go", "to", "the", "beach", "every", "summer"], "b": ["when", "i", "was", "a", "child", "i", "went", "to", "the", "beach", "every", "summer"], "blocks": [[0, 0, 3], [3, 4, 2], [6, 7, 5], [11, 12, 0]], "opcodes": [["equal", 0, 3, 0, 3], ["insert", 3, 3, 3, 4], ["equal", 3, 5, 4, 6], ["replace", 5, 6, 6, 7], ["equal", 6, 11, 7, 12]], "ratio": 0.8695652173913043},
  {"a": ["i", "like", "to", "play", "guitar", "i", "play", "since", "i", "was", "fifteen"], "b": ["i", "like", "to", "play", "guitar", "and", "i've", "been", "playing", "since", "i", "was", "fifteen"], "blocks": [[0, 0, 5], [7, 9, 4], [11, 13, 0]], "opcodes": [["equal", 0, 5, 0, 5], ["replace", 5, 7, 5, 9], ["equal", 7, 11, 9, 13]], "ratio": 0.75},
  {"a": ["when", "i", "was", "child", "i", "go", "to", "the", "beach", "every", "summer", "with", "my", "parents", "and", "my", "brother", "we", "was", "very", "happy", "we", "make", "many", "things", "together", "like", "to", "swim", "and", "to", "play", "football", "in", "the", "sand", "and", "in", "the", "night", "we", "eat", "fish", "in", "a", "restaurant", "near", "of", "our", "house", "i", "miss", "very", "much", "this", "time"], "b": ["when", "i", "was", "a", "child", "i", "went", "to", "the", "beach", "every", "summer", "with", "my", "relatives", "and", "my", "brother", "we", "were", "very", "happy", "and", "did", "many", "things", "together", "like", "swimming", "and", "playing", "football", "in", "the", "sand", "at", "night", "we", "ate", "fish", "in", "a", "restaurant", "near", "our", "house", "i", "miss", "that", "time", "very", "much"], "blocks": [[0, 0, 3], [3, 4, 2], [6, 7, 7], [14, 15, 4], [19, 20, 2], [23, 24, 4], [29, 29, 1], [32, 31, 4], [39, 36, 2], [42, 39, 5], [48, 44, 4], [52, 50, 2], [56, 52, 0]], "opcodes": [["equal", 0, 3, 0, 3], ["insert", 3, 3, 3, 4], ["equal", 3, 5, 4, 6], ["replace", 5, 6, 6, 7], ["equal", 6, 13, 7, 14], ["replace", 13, 14, 14, 15], ["equal", 14, 18, 15, 19], ["replace", 18, 19, 19, 20], ["equal", 19, 21, 20, 22], ["replace", 21, 23, 22, 24], ["equal", 23, 27, 24, 28], ["replace", 27, 29, 28, 29], ["equal", 29, 30, 29, 30], ["replace", 30, 32, 30, 31], ["equal", 32, 36, 31, 35], ["replace", 36, 39, 35, 36], ["equal", 39, 41, 36, 38], ["replace", 41, 42, 38, 39], ["equal", 42, 47, 39, 44], ["delete", 47, 48, 44, 44], ["equal", 48, 52, 44, 48], ["insert", 52, 52, 48, 50], ["equal", 52, 54, 50, 52], ["delete", 54, 56, 52, 52]], "ratio": 0.7407407407407407},
  {"a": ["last", "year", "i", "have", "gone", "to", "rio", "with", "my", "family", "and", "we", "stayed", "in", "a", "hotel", "near", "the", "sea"], "b": ["last", "year", "i", "went", "to", "rio", "with", "my", "family", "and", "we", "stayed", "in", "a", "hotel", "near", "the", "sea"], "blocks": [[0, 0, 3], [5, 4, 14], [19, 18, 0]], "opcodes": [["equal", 0, 3, 0, 3], ["replace", 3, 5, 3, 4], ["equal", 5, 19, 4, 18]], "ratio": 0.918918918918919},
  {"a": ["i", "have", "gone", "to", "rio", "with", "my", "family", "and", "we", "stayed", "at", "a", "hotel"], "b": ["i", "have", "gone", "to", "rio", "with", "my", "family", "and", "we", "stayed", "in", "a", "hotel"], "blocks": [[0, 0, 11], [12, 12, 2], [14, 14, 0]], "opcodes": [["equal", 0, 11, 0, 11], ["replace", 11, 12, 11, 12], ["equal", 12, 14, 12, 14]], "ratio": 0.9285714285714286},
  {"a": ["i", "am", "work", "in", "a", "bank", "since", "five", "years", "and", "i", "like", "very", "much", "my", "job"], "b": ["i", "have", "been", "working", "in", "a", "bank", "for", "five", "years", "and", "i", "really", "like", "my", "job"], "blocks": [[0, 0, 1], [3, 4, 3], [7, 8, 4], [11, 13, 1], [14, 14, 2], [16, 16, 0]], "opcodes": [["equal", 0, 1, 0, 1], ["replace", 1, 3, 1, 4], ["equal", 3, 6, 4, 7], ["replace", 6, 7, 7, 8], ["equal", 7, 11, 8, 12], ["insert", 11, 11, 12, 13], ["equal", 11, 12, 13, 14], ["delete", 12, 14, 14, 14], ["equal", 14, 16, 14, 16]], "ratio": 0.6875},
  {"a": ["my", "main", "stack", "is", "web", "development", "and", "i", "work", "has", "been", "show", "use"], "b": ["my", "main", "stack", "is", "web", "development", "and", "i", "have", "been", "working", "as", "a", "software", "engineer", "for", "five", "years"], "blocks": [[0, 0, 8], [10, 9, 1], [13, 18, 0]], "opcodes": [["equal", 0, 8, 0, 8], ["replace", 8, 10, 8, 9], ["equal", 10, 11, 9, 10], ["replace", 11, 13, 10, 18]], "ratio": 0.5806451612903226},
  {"a": ["and", "after", "send", "another", "audio", "to", "konshinui", "the", "tzauki", "and", "it's", "for", "learning"], "b": ["and", "after", "that", "i", "send", "another", "audio", "to", "continue", "the", "talk"], "blocks": [[0, 0, 2], [2, 4, 4], [7, 9, 1], [13, 11, 0]], "opcodes": [["equal", 0, 2, 0, 2], ["insert", 2, 2, 2, 4], ["equal", 2, 6, 4, 8], ["replace", 6, 7, 8, 9], ["equal", 7, 8, 9, 10], ["replace", 8, 13, 10, 11]], "ratio": 0.5833333333333334},
  {"a": ["um", "so", "i", "uh", "went", "to", "the", "beach"], "b": ["um", "so", "i", "uh", "went"], "blocks": [[0, 0, 5], [8, 5, 0]], "opcodes": [["equal", 0, 5, 0, 5], ["delete", 5, 8, 5, 5]], "ratio": 0.7692307692307693},
  {"a": ["i", "wake", "up", "at", "7", "a", "m", "and", "i", "work"], "b": ["i", "wake", "up", "at", "7", "a", "m", "and", "i", "work"], "blocks": [[0, 0, 10], [10, 10, 0]], "opcodes": [["equal", 0, 10, 0, 10]], "ratio": 1.0},
  {"a": ["a", "b", "c"], "b": ["A", "B", "C"], "blocks": [[3, 3, 0]], "opcodes": [["replace", 0, 3, 0, 3]], "ratio": 0.0},
  {"a": ["é", "à", "ç"], "b": ["e", "a", "c"], "blocks": [[3, 3, 0]], "opcodes": [["replace", 0, 3, 0, 3]], "ratio": 0.0},
  {"a": ["a", "b"], "b": ["b", "a"], "blocks": [[0, 1, 1], [2, 2, 0]], "opcodes": [["insert", 0, 0, 0, 1], ["equal", 0, 1, 1, 2], ["delete", 1, 2, 2, 2]], "ratio": 0.5},
  {"a": ["a", "b", "c", "d", "e"], "b": ["e", "d", "c", "b", "a"], "blocks": [[0, 4, 1], [5, 5, 0]], "opcodes": [["insert", 0, 0, 0, 4], ["equal", 0, 1, 4, 5], ["delete", 1, 5, 5, 5]], "ratio": 0.2},
  {"a": ["x", "y", "z", "x", "y", "z"], "b": ["x", "y", "z"], "blocks": [[0, 0, 3], [6, 3, 0]], "opcodes": [["equal", 0, 3, 0, 3], ["delete", 3, 6, 3, 3]], "ratio": 0.6666666666666666},
  {"a": ["x", "y", "z"], "b": ["x", "y", "z", "x", "y", "z"], "blocks": [[0, 0, 3], [3, 6, 0]], "opcodes": [["equal", 0, 3, 0, 3], ["insert", 3, 3, 3, 6]], "ratio": 0.6666666666666666},
  {"a": ["a", "b", "c", "b", "a"], "b": ["b", "c", "b"], "blocks": [[1, 0, 3], [5, 3, 0]], "opcodes": [["delete", 0, 1, 0, 0], ["equal", 1, 4, 0, 3], ["delete", 4, 5, 3, 3]], "ratio": 0.75},
  {"a": ["the", "cat", "sat", "on", "the", "mat", "the", "end"], "b": ["the", "mat", "sat", "on", "the", "cat", "the", "end", "the"], "blocks": [[0, 0, 1], [2, 2, 3], [6, 6, 2], [8, 9, 0]], "opcodes": [["equal", 0, 1, 0, 1], ["replace", 1, 2, 1, 2], ["equal", 2, 5, 2, 5], ["replace", 5, 6, 5, 6], ["equal", 6, 8, 6, 8], ["insert", 8, 8, 8, 9]], "ratio": 0.7058823529411765},
  {"a": ["i", "i", "i", "i", "i"], "b": ["i"], "blocks": [[0, 0, 1], [5, 1, 0]], "opcodes": [["equal", 0, 1, 0, 1], ["delete", 1, 5, 1, 1]], "ratio": 0.3333333333333333},
  {"a": ["to", "be", "or", "not", "to", "be"], "b": ["not", "to", "be", "or", "to", "be"], "blocks": [[0, 1, 3], [4, 4, 2], [6, 6, 0]], "opcodes": [["insert", 0, 0, 0, 1], ["equal", 0, 3, 1, 4], ["delete", 3, 4, 4, 4], ["equal", 4, 6, 4, 6]], "ratio": 0.8333333333333334},
  {"a": ["b", "c"], "b": [], "blocks": [[2, 0, 0]], "opcodes": [["delete", 0, 2, 0, 0]], "ratio": 0.0},
  {"a": ["a", "a", "a", "a", "a", "a", "a", "a"], "b": ["a"], "blocks": [[0, 0, 1], [8, 1, 0]], "opcodes": [["equal", 0, 1, 0, 1], ["delete", 1, 8, 1, 1]], "ratio": 0.2222222222222222},
  {"a": ["a", "a", "a", "a", "a", "a", "a", "a"], "b": [], "blocks": [[8, 0, 0]], "opcodes": [["delete", 0, 8, 0, 0]], "ratio": 0.0},
  {"a": ["b", "a", "a", "b"], "b": ["a", "a", "a", "b", "a", "a", "a", "a"], "blocks": [[0, 3, 3], [4, 8, 0]], "opcodes": [["insert", 0, 0, 0, 3], ["equal", 0, 3, 3, 6], ["replace", 3, 4, 6, 8]], "ratio": 0.5},
  {"a": ["d", "c", "d", "d", "c", "c", "b", "b", "b", "a"], "b": ["c", "d", "c", "d", "c", "a", "a", "d", "b"], "blocks": [[0, 1, 3], [3, 7, 1], [6, 8, 1], [10, 9, 0]], "opcodes": [["insert", 0, 0, 0, 1], ["equal", 0, 3, 1, 4], ["insert", 3, 3, 4, 7], ["equal", 3, 4, 7, 8], ["delete", 4, 6, 8, 8], ["equal", 6, 7, 8, 9], ["delete", 7, 10, 9, 9]], "ratio": 0.5263157894736842},
  {"a": ["b", "b"], "b": [], "blocks": [[2, 0, 0]], "opcodes": [["delete", 0, 2, 0, 0]], "ratio": 0.0},
  {"a": ["a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a"], "b": ["a", "a", "a", "a", "a", "a", "a", "a", "a", "a"], "blocks": [[0, 0, 10], [12, 10, 0]], "opcodes": [["equal", 0, 10, 0, 10], ["delete", 10, 12, 10, 10]], "ratio": 0.9090909090909091},
  {"a": ["a", "a", "a"], "b": ["a", "a", "a", "a", "a", "a"], "blocks": [[0, 0, 3], [3, 6, 0]], "opcodes": [["equal", 0, 3, 0, 3], ["insert", 3, 3, 3, 6]], "ratio": 0.6666666666666666},
  {"a": ["b", "c"], "b": ["c", "b", "b", "c"], "blocks": [[0, 2, 2], [2, 4, 0]], "opcodes": [["insert", 0, 0, 0, 2], ["equal", 0, 2, 2, 4]], "ratio": 0.6666666666666666},
  {"a": ["b", "a", "b"], "b": ["b", "b"], "blocks": [[0, 0, 1], [2, 1, 1], [3, 2, 0]], "opcodes": [["equal", 0, 1, 0, 1], ["delete", 1, 2, 1, 1], ["equal", 2, 3, 1, 2]], "ratio": 0.8},
  {"a": ["a", "a", "a", "a", "a", "a", "a"], "b": ["a", "a", "a", "a", "a", "a", "a", "a", "a"], "blocks": [[0, 0, 7], [7, 9, 0]], "opcodes": [["equal", 0, 7, 0, 7], ["insert", 7, 7, 7, 9]], "ratio": 0.875},
  {"a": ["d", "a", "b", "a", "b", "d", "b", "a", "c", "a"], "b": ["a"], "blocks": [[1, 0, 1], [10, 1, 0]], "opcodes": [["delete", 0, 1, 0, 0], ["equal", 1, 2, 0, 1], ["delete", 2, 10, 1, 1]], "ratio": 0.18181818181818182},
  {"a": ["a", "b", "a", "a", "a", "b", "a", "b"], "b": ["b", "b", "a", "a", "b"], "blocks": [[1, 1, 3], [5, 4, 1], [8, 5, 0]], "opcodes": [["replace", 0, 1, 0, 1], ["equal", 1, 4, 1, 4], ["delete", 4, 5, 4, 4], ["equal", 5, 6, 4, 5], ["delete", 6, 8, 5, 5]], "ratio": 0.6153846153846154},
  {"a": ["d", "c", "a", "b", "a", "c", "c"], "b": ["b", "a", "b", "c", "b", "a", "c"], "blocks": [[1, 3, 1], [3, 4, 3], [7, 7, 0]], "opcodes": [["replace", 0, 1, 0, 3], ["equal", 1, 2, 3, 4], ["delete", 2, 3, 4, 4], ["equal", 3, 6, 4, 7], ["delete", 6, 7, 7, 7]], "ratio": 0.5714285714285714},
  {"a": ["a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a"], "b": ["a", "a", "a"], "blocks": [[0, 0, 3], [11, 3, 0]], "opcodes": [["equal", 0, 3, 0, 3], ["delete", 3, 11, 3, 3]], "ratio": 0.42857142857142855},
  {"a": ["a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a"], "b": ["a", "a", "a", "a", "a", "a", "a"], "blocks": [[0, 0, 7], [12, 7, 0]], "opcodes": [["equal", 0, 7, 0, 7], ["delete", 7, 12, 7, 7]], "ratio": 0.7368421052631579},
  {"a": ["a", "a", "a", "a", "a", "a", "a", "a", "a", "a"], "b": ["a", "a", "a", "a", "a", "a"], "blocks": [[0, 0, 6], [10, 6, 0]], "opcodes": [["equal", 0, 6, 0, 6], ["delete", 6, 10, 6, 6]], "ratio": 0.75},
  {"a": ["b", "d", "c", "b", "b", "a", "a", "a", "b", "d", "b", "b"], "b": [], "blocks": [[12, 0, 0]], "opcodes": [["delete", 0, 12, 0, 0]], "ratio": 0.0},
  {"a": ["b", "c", "a"], "b": ["c", "b", "b", "c", "b", "a", "a", "c", "b", "b", "c", "c"], "blocks": [[0, 2, 2], [2, 5, 1], [3, 12, 0]], "opcodes": [["insert", 0, 0, 0, 2], ["equal", 0, 2, 2, 4], ["insert", 2, 2, 4, 5], ["equal", 2, 3, 5, 6], ["insert", 3, 3, 6, 12]], "ratio": 0.4},
  {"a": ["b", "b", "a", "d", "b", "a", "b", "b"], "b": ["d", "a"], "blocks": [[2, 1, 1], [8, 2, 0]], "opcodes": [["replace", 0, 2, 0, 1], ["equal", 2, 3, 1, 2], ["delete", 3, 8, 2, 2]], "ratio": 0.2},
  {"a": ["a", "a", "a", "a", "a"], "b": ["a", "a", "a", "a"], "blocks": [[0, 0, 4], [5, 4, 0]], "opcodes": [["equal", 0, 4, 0, 4], ["delete", 4, 5, 4, 4]], "ratio": 0.8888888888888888},
  {"a": ["a", "a", "a", "a", "a", "a", "a"], "b": ["a", "a", "a", "a", "a", "a", "a", "a"], "blocks": [[0, 0, 7], [7, 8, 0]], "opcodes": [["equal", 0, 7, 0, 7], ["insert", 7, 7, 7, 8]], "ratio": 0.9333333333333333},
  {"a": ["a", "a", "a", "a", "a", "a", "a", "a", "a", "a"], "b": ["a", "a"], "blocks": [[0, 0, 2], [10, 2, 0]], "opcodes": [["equal", 0, 2, 0, 2], ["delete", 2, 10, 2, 2]], "ratio": 0.3333333333333333},
  {"a": ["a", "a", "a", "a", "a", "a"], "b": ["a", "a", "a", "a", "a"], "blocks": [[0, 0, 5], [6, 5, 0]], "opcodes": [["equal", 0, 5, 0, 5], ["delete", 5, 6, 5, 5]], "ratio": 0.9090909090909091},
]
;

describe("SequenceMatcher (difflib port)", () => {
  it("has enough fixtures", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(CASES.map((c, i) => [i, c] as const))("matches difflib on case %i", (_, c) => {
    const sm = new SequenceMatcher(c.a, c.b);
    expect(sm.getMatchingBlocks()).toEqual(c.blocks);
    expect(sm.getOpcodes()).toEqual(c.opcodes);
    expect(sm.ratio()).toBe(c.ratio);
  });

  it("finds the longest match the way difflib breaks ties", () => {
    // difflib: SequenceMatcher(None, "abab", "baba").find_longest_match(0, 4, 0, 4) == (0, 1, 3) and
    // find_longest_match(1, 4, 0, 2) == (1, 0, 2)
    const sm = new SequenceMatcher([..."abab"], [..."baba"]);
    expect(sm.findLongestMatch()).toEqual([0, 1, 3]);
    expect(sm.findLongestMatch(1, 4, 0, 2)).toEqual([1, 0, 2]);
  });
});
