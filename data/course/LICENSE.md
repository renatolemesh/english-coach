# Course data: sources and licences

`words.jsonl` and `sentences.jsonl` are generated offline by `scripts/build-course.ts` from the
three sources below. Do not edit them by hand; change the script and rebuild.

## CEFR-J Wordlist 1.5 (headwords, parts of speech, levels)

The CEFR-J Wordlist Version 1.5, compiled by Yukio Tono, Tokyo University of Foreign Studies
(Tono Laboratory, TUFS), http://www.cefr-j.org/, via Open Language Profiles
(https://github.com/openlanguageprofiles/olp-en-cefrj). Free for research and commercial use
provided the dataset is cited; copyright Tono Laboratory, TUFS. Neither CEFR-J nor Open Language
Profiles is responsible for inaccuracies in the data.

## Tatoeba (sentences and translations)

Sentences and their Portuguese translations come from Tatoeba (https://tatoeba.org), licensed
under CC BY 2.0 FR (https://creativecommons.org/licenses/by/2.0/fr/). Every record keeps its
Tatoeba ids in `src` (`tatoeba:<English id>-<Portuguese id>`); authors are credited on each
sentence page, `https://tatoeba.org/sentences/show/<id>`. `alt_en` holds other English sentences
linked to the same Portuguese one. Changes: selection and filtering, and the names "Tom" and
"Mary" replaced by other first names in both languages.

## Portuguese Wiktionary via Wiktextract (glosses)

Portuguese glosses and alternatives are derived from the Portuguese Wiktionary
(https://pt.wiktionary.org), extracted by Wiktextract (Tatu Ylönen, "Wiktextract: Wiktionary as
Machine-Readable Structured Data", LREC 2022) and distributed by https://kaikki.org. Wiktionary
text is licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/); the
derived word list (`words.jsonl`) is therefore offered under CC BY-SA 4.0 as well.

## Scope

These licences cover only the data files in this directory. The TypeScript code (including
`scripts/build-course.ts`) is not affected. `traps.yaml` is original content written for this
project and does not come from these sources.
