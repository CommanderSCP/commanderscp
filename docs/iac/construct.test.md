# construct.test

Reference for `packages/iac/src/construct.test.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 15 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. Do not "fix" this to emit `producers: []`

Do not "fix" this to emit `producers: []`. An empty array is a PRESENT collection, which the server reads as "I manage producers and declare none" and therefore PRUNES; an absent key means UNMANAGED. Emitting `[]` here would make every stack that ever dropped a `producesDependency(...)` call retract that coordinate back to a public index on the next apply — the accepted cost documented on `Stack.addDependencyProducer` runs in this direction precisely so the catastrophic one cannot.

## §2. Do not "fix" this to emit `governanceMoveRungs: []`

Do not "fix" this to emit `governanceMoveRungs: []`. An empty array is a PRESENT collection, which the server reads as "I manage rungs and declare none" and therefore DISABLES every rung on a container this stack owns. An absent key means UNMANAGED. Emitting `[]` here would un-govern a subtree on the next apply of every stack that ever declared a rung and later dropped it — and the symptom would be moves quietly succeeding, which nothing surfaces.

## §3. TWO CONSTRUCTS, ONE URN

TWO CONSTRUCTS, ONE URN — the case-folding collision `Stack.synth()` refuses.

Found by `products.test.ts`'s fast-check generator (id pair `("F", "f")`, CI seed 1953244992): `urn.ts`'s `slugify` lowercases, so sibling ids differing only in case derive ONE URN while the tree treats them as two constructs. Nothing downstream could catch it — the manifest schema has no cross-entry constraint and the server diffs BY URN, so the second entry silently became an update of the first and one declared object never existed.
