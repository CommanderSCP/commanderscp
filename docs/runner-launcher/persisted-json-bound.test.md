# persisted-json-bound.test

Reference for `packages/runner-launcher/src/persisted-json-bound.test.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 28 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE VALUE ALONE

THE VALUE ALONE. `boundPersistedJson` returns `{ value, truncation }` since M23.1g — deliberately inseparable, so no caller can obtain the bounded value without being handed the report — and every arm below this line is about the VALUE. The report has its own file, `persisted-json-truncation.test.ts`, because it is a different property: these arms measure what survives, those measure whether we say what did not.

## §2. THE CYCLE GUARD

THE CYCLE GUARD. `adversarial-corpus.ts` cannot import `PERSISTED_JSON_ELIDED_KEY` from `./index.js` — `index.ts` re-exports the corpus, and the cycle resolves to `undefined` at module-evaluation time, which silently turns `ADVERSARIAL_ALL` into an empty array for every consumer that imports it through the package entry. So the corpus spells the marker as a literal, and this is what stops the literal drifting from the constant.

## §3. 69 fields plus the marker

69 fields plus the marker. It was 70 + the marker until pass 14 made the object BUY its elision entry before phase 1 seats anything (see `fieldsElisionCost`): those 30 characters used to be spent out of the row's backstop cushion, and one seat is exactly what they buy. The measurement that says the trade is worth making is in that comment — 15 982 whole-value discards over a 145 048-pair budget sweep, gone above a budget of 31.

## §4. ONE LAW FOR EVERY SHAPE

ONE LAW FOR EVERY SHAPE. `boundPersistedJson` reserves PERSISTED_JSON_MIN_LEAF from the row as its overspend backstop and the walk gets the rest, so a field that costs L wants exactly L + 96 — and that was true of scalars and objects while ARRAYS wanted `L + 96 + the tail marker's price`, a marker the complete list never stores. Measured before the fix:

```text
  {a: ["a"]}          L 11    verbatim from 134, not 107
  {a: [40 entries]}   L 237   verbatim from 361, not 333
```

Stated as a two-sided law so it cannot be satisfied by simply reserving more: verbatim at L + 96, and NOT verbatim at L + 95.
