# Output specification — `rules-engine-explained.md`

The contract for the generated document: who it is for, what sections it has, and
the rules that keep it honest. Follow this exactly; the sections are ordered so a
reader can stop at any point and still have a complete answer at that level of
detail.

## Audience and register

Write for **a knowledgeable non-programmer** — an ecologist, product owner, policy
colleague, or a developer new to the domain. They understand biodiversity net gain
as a subject. They do not read JavaScript and should never need to.

- **No code.** No function names, file paths, variable names, or JavaScript in the
  body. Source references belong in the final "Where this lives in the code"
  section and nowhere else.
- **Name the concept, not the identifier.** "the difficulty of creating that
  habitat", not `getDifficultyMultiplier`. "the number of years the work is put
  back", not `delayYears`.
- **Short sentences, full sentences.** No arrow chains (`A → B → C`), no bullet
  fragments where a sentence would read better.
- **Every number is traceable.** Any figure that appears in the prose must come
  from the facts file or the worked-example run. Never round, restate, or infer a
  multiplier from memory.
- **Explain the why, not just the what.** "Habitat that takes longer to establish
  is worth less now, because there is more chance it never gets there" beats
  "a time multiplier is applied".

## Required sections, in order

### 1. In one paragraph

What the rules engine is and what question it answers. A reader who stops here
should be able to explain it to someone else in a sentence.

### 2. The shape of every calculation

The common form all unit calculations take — size, multiplied by what the habitat
is worth, multiplied by what state it is in, then adjusted for risk. Establish the
vocabulary the rest of the document uses. State plainly that baseline and retained
habitat carry **no** risk adjustment, and why: nothing is being predicted about
the future, so there is nothing to discount.

### 3. The four inputs that set the value

One subsection each for **distinctiveness**, **condition**, **time**, and
**difficulty**. For each: what it means in the real world, where its value comes
from, and the actual bands with their numbers as a small table. Distinctiveness
and condition set the headline value; time and difficulty are the two **risk**
multipliers that discount it.

### 4. How the engine picks the time multiplier

This is a core deliverable of the story. Cover in order:

1. Looking up how many years the habitat takes to reach the target condition —
   noting that creation and enhancement use different tables, and that enhancement
   depends on the starting condition as well as the target.
2. Adding delay years and subtracting advance years to get the actual number of
   years of waiting.
3. Clamping the result: never below zero, and anything beyond the 30-year ceiling
   falls into a single "more than 30 years" band.
4. Reading the multiplier off the year count.

Explain the shape of the curve in plain terms — each additional year of waiting
removes a fixed small percentage of the value, so the discount compounds.

### 5. How the engine picks the difficulty multiplier

The second core deliverable, and the subtler of the two. Cover:

1. The habitat's own difficulty band, which differs for creating a habitat from
   scratch versus improving one that is already there.
2. **The advance-time override**: if the head start already covers the remaining
   years to target, difficulty stops applying altogether.
3. **The partial-advance rule**: a created habitat with enough head start to have
   reached poor condition is scored using the *enhancement* difficulty band rather
   than the creation one, because in practice it is now being improved rather than
   made from nothing.

State explicitly that these comparisons are made against the time-to-target *after*
advance has been applied, not the original figure — this is what produces the sharp
step in the worked examples, and it will confuse anyone who assumes otherwise.

### 6. Decision diagram and decision table

**Both**, because they serve different renderers and different readers.

A Mermaid `flowchart TD` showing the path from a habitat parcel to its two risk
multipliers. Keep the node labels in the same plain English as the prose — a reader
should be able to follow the diagram without having read section 5. Include the
retained/baseline short-circuit, the advance override, and the partial-advance
branch. Split it into **two flowcharts** — one for the time multiplier, one for
difficulty — rather than one chart carrying both; a single diagram holding the
advance override *and* the partial-advance branch becomes unfollowable.

**Keep every node label under about 30 characters.** Mermaid does not wrap them, so
a long label makes the whole diagram wide, and a wide diagram prints small or spills
across pages. No `<br/>` to force wrapping either — that shows as literal text in
Confluence. Shorten the wording instead: "Already at poor condition?" rather than
"Is this a created habitat with enough advance to have reached poor condition?". The
surrounding prose carries the detail; the diagram carries the shape.

Then the same logic as a **decision table**: one row per situation, columns for the
habitat's state (created/enhanced/retained), the timing, which time multiplier
applies, and which difficulty band. Confluence renders tables natively but **not**
Mermaid, so the table is what most readers will actually see. It is not a fallback
grudgingly included — for "which multiplier applies when", a table is arguably the
clearer form, and it directly answers the story's acceptance criteria.

### 6a. Charts

Insert the three generated charts between the `<!-- charts:start -->` and
`<!-- charts:end -->` markers, each with one sentence of lead-in saying what the
reader should take from it:

- **`time-multiplier-decay.svg`** — belongs in section 4, showing the compounding
  decay as a curve rather than 32 table rows.
- **`advance-sensitivity.svg`** — belongs in section 5, showing the step change
  where the difficulty rule switches.
- **`enhancement-uplift.svg`** — belongs in section 3 or 9, showing that only the
  uplift is discounted.

Reference them with plain Markdown image syntax and meaningful alt text. Charts are
generated by `render-charts.mjs`; never hand-edit an SVG, and never describe a
chart as showing something you have not confirmed it shows.

### 7. Worked examples

The generated tables from `run-worked-examples.mjs`, inserted verbatim between the
`<!-- worked-examples:start -->` and `<!-- worked-examples:end -->` markers. Above
them, one short paragraph telling the reader these figures are produced by running
the real engine each time the document is rebuilt, so they always match the shipped
behaviour. Below them, call out anything counter-intuitive the numbers reveal.

### 7a. What the engine reports back

The engine returns more than a unit total: for enhancement it also names the
**difficulty band** it chose (`Low` / `Medium` / `High`) and the **standard time to
target** for that habitat and condition change. Cover both, because a screen or
report showing these values needs them explained:

- The difficulty band label always agrees with the difficulty multiplier. It is the
  reasoning behind the number, expressed in words.
- The standard time to target is the figure **from the statutory table**, before any
  advance or delay is applied. It is the calculation's starting point, not its
  result. Say this plainly — a reader seeing "standard time to target: 10 years"
  beside a time multiplier of 0.49 will otherwise assume one is wrong.
- Both fields are returned for **enhancement only**. Created and retained habitat do
  not carry them. Note the asymmetry rather than letting a reader infer it is
  universal.

### 8. Things that surprise people

The behaviours a careful reader would get wrong if they assumed the obvious. Each
one gets a heading, a plain statement of the surprise, and the evidence from the
worked examples. Include at minimum any behaviour discovered during the trace that
is not stated in the statutory guidance. Do not manufacture entries — if a re-run
finds only two genuine surprises, publish two.

### 9. Habitat types beyond area habitats

How hedgerows and watercourses differ: measured by length rather than area, their
own lookup tables, and for watercourses the extra encroachment adjustment. Keep it
brief and say clearly that the rule for *choosing* multipliers is the same one.

### 10. What the engine deliberately does not do

Scope boundaries — the things a reader might reasonably expect to find and will
not. Say what does own them instead where that is known.

### 11. Where this lives in the code

The only section that names files. A short table: area of behaviour, the file that
implements it, and the reference table it reads. Plus the engine's package version,
the commit the document was generated from, and the generation date, taken from the
facts file.

## Front matter

Open the document with a short provenance block: what it describes, that it is
generated and how to regenerate it, and the engine version and commit it reflects.
Anyone finding a stale copy should immediately know it is generated rather than
hand-maintained, so they fix the generator instead of editing the output.

## Formatting rules

**Confluence is the final destination**, so it wins every formatting trade-off.

- Tables for anything enumerable — bands, multipliers, file mappings. Tables are the
  one rich construct that survives everywhere.
- **No HTML tags at all.** A raw `<br>` renders as literal text in Confluence.
- No nested bullet lists deeper than one level; Confluence's paste conversion
  mangles them.
- Mermaid in a fenced ` ```mermaid ` block. It renders on GitHub natively and on the
  docs site once the superfences custom fence is configured. It does **not** render
  in stock Confluence — which is why section 6 also requires the decision table.
- Charts as Markdown image references to the generated SVGs. In Confluence these
  become uploaded attachments (see the publishing step in `SKILL.md`), so keep the
  filenames stable across runs — a renamed chart means a broken Confluence image.
- Keep the reference tables that are reproduced in full to the genuinely small ones
  (difficulty bands, distinctiveness scores). Large per-habitat tables get a
  description and a pointer, never a 130-row dump.

## Why the charts look the way they do

The charts commit to a **single light surface** rather than adapting to the reader's
theme. Theme adaptation needs CSS inside the SVG, and GitHub strips `<style>` from
SVG while Confluence serves them as flat attachments — so an "adaptive" chart would
simply break in two of the three places it has to work. On a dark background the
chart reads as a light card, which is the correct trade.

The palette is the validated three-slot categorical set from the `dataviz` skill.
If you add a chart, run that skill's `validate_palette.js` before choosing colours
rather than picking by eye, and keep every mark directly labelled — the aqua slot
sits below 3:1 contrast on the light surface, so visible labels are what make it
legible rather than optional polish.
