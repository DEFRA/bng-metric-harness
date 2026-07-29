# Output specification — `geopackage-validation-explained.md`

The contract for the generated document: who it is for, what sections it has, and
the rules that keep it honest. Follow this exactly. The sections are ordered so a
reader can stop at any point and still have a complete answer at that level of
detail.

This document sits beside `rules-engine-explained.md` in `docs/` and shares its
register. That one explains how units are *calculated*; this one explains what
makes a file *acceptable* in the first place. Cross-link them once each, and do
not duplicate either one's content in the other.

## Audience and register

Write for **a knowledgeable non-programmer** — an ecologist, planning consultant,
product owner, or policy colleague. They understand biodiversity net gain and they
work in a GIS package. They do not read JavaScript and should never need to.

- **No code in the body.** No error codes, function names, file paths, table names
  or SQL. Error codes appear in the rule index (section 10) and nowhere else.
- **Name what the reader sees, not what the system calls it.** "the red line
  boundary is missing", not `NO_REDLINE`. "the file is not a GeoPackage", not
  `application_id`.
- **Every rule ends with a fix.** The user story is about knowing *what to
  change*. A rule described without a remedy has not been documented, it has been
  transcribed. If the remedy is genuinely unknown, say so rather than inventing
  one.
- **Short sentences, full sentences.** No arrow chains, no bullet fragments where
  a sentence reads better.
- **Tolerances in the reader's units.** Square metres, metres, square kilometres.
  Always say that a difference smaller than the tolerance passes — otherwise a
  reader chases a 0.2 m² overlap that the service never objected to.
- **Never overstate what the user is told.** Most codes reach the user as a
  generic message. Where that is true, the document says so.

## Required sections, in order

### 1. In one paragraph

What the service checks when a GeoPackage is uploaded, and what happens when a
check fails. A reader who stops here should be able to explain it to a colleague.

### 2. The two things "invalid" can mean

The distinction that governs everything else, and the one readers most often get
wrong:

- **The upload is rejected.** Nothing is saved, the user is sent to an error page,
  and they must fix the file and upload again.
- **The upload is accepted but a feature scores nothing.** The file is fine as a
  file; one habitat inside it could not be scored, so it shows as Incomplete and
  contributes zero units.

State plainly that only the first produces an error message, and that a successful
upload is therefore **not** confirmation that every feature was understood. This
section exists because it is the single most likely misreading of the rest of the
document.

### 3. Before anything else — is it a GeoPackage at all?

The file-level checks: readable as a GeoPackage, carries the system tables a
GeoPackage must have. Short section; these fail rarely and usually mean the file
was exported wrongly or truncated in transit.

### 4. Does it match the Natural England template?

Layers, columns and coordinate reference system. Explain that the service compares
the upload against a fixed template rather than accepting any GeoPackage, and why
that is stricter than it may appear: a renamed column or an extra layer fails even
though the map looks correct in a GIS package.

Group the checks the way the reader would investigate them — the layers that must
be present, the columns each layer must carry and in what form, and the coordinate
reference system. Say what the remedy is in every case: start from the supplied
template rather than repairing a hand-built file.

**This is where most of the rules live and where the user is told least.** Nearly
all of these currently produce a generic message, so a reader who lands here
cannot tell from the screen which rule they broke. Say so explicitly.

### 5. Is the mapping usable?

The geometry checks: one red line boundary and not more, habitat parcels that are
valid polygons, hedgerows and watercourses that are lines. Explain self-intersection
in plain terms — a boundary that crosses itself has no unambiguous inside — and say
that most GIS packages have a repair or validate tool that fixes it.

Cover which layers are required and which are optional, and state that an optional
layer left empty is not an error.

### 6. Does the mapping hang together?

The spatial relationships: parcels inside the boundary, parcels not overlapping
each other, no gaps left inside the boundary, the habitat total matching the
boundary area. This is the section where tolerances matter most — give each one
and say what passes.

Explain slivers carefully. A hairline gap between two parcels is invisible at
normal zoom and is the most common reason a carefully-drawn file is rejected.

### 7. Is the habitat data acceptable?

The attribute rules: distinctiveness bands that are out of scope for the service,
duplicate parcel references, and advance and delay years both set on one feature.
For the last one, say that the statutory metric allows one or the other, not both.

### 8. What to do when a file is rejected

A short practical section: the error page shows one problem at a time, so fixing
and re-uploading may surface a second; where the message is generic, the most
productive first move is to re-export from the template.

### 9. What this document does not cover

Scope boundaries — how units are calculated (point at
`rules-engine-explained.md`), the post-intervention file if it is out of scope for
this run, and anything the trace found that belongs elsewhere.

### 10. Rule index

The only section that names error codes, and the section `doc-coverage.mjs`
checks. A table with one row per code in the registry:

| Column | Contents |
| --- | --- |
| Error code | Exactly as it appears in the registry |
| Explained in | The heading of the section above that covers it, matching that heading's text |
| What the user sees | `bespoke message`, `placeholder`, or `generic message` — taken from the facts file, never guessed |
| Test fixture | The fixture that exercises it, or `none` |

Every code in the facts file must appear. A code with no fixture and a generic
message is not a reason to omit the row — it is the most important row in the
table, because it marks a rule nothing tests and nobody is told about.

Introduce the table with one sentence explaining that it is for maintainers, not
for the reader who came here to fix a file.

### 11. Where this lives in the code

Package versions, the commit of each of the three repos the document was generated
from, and the generation date, taken from the facts file.

## Front matter

Open with a short provenance block: what the document describes, that it is
generated and how to regenerate it, and the three commits it reflects. Anyone
finding a stale copy should immediately know to fix the generator rather than edit
the output.

## Formatting rules

**Confluence is the final destination**, so it wins every formatting trade-off.

- Tables for anything enumerable. Tables are the one rich construct that survives
  everywhere.
- **No HTML tags at all.** A raw `<br>` renders as literal text in Confluence.
- No nested bullet lists deeper than one level; Confluence's paste conversion
  mangles them.
- Mermaid in a fenced ` ```mermaid ` block if a diagram genuinely helps. It renders
  on GitHub and on the docs site, but **not** in stock Confluence — so anything it
  carries must also exist as prose or a table.
- Keep node labels under about 30 characters. Mermaid does not wrap them and
  `<br/>` shows as literal text in Confluence.

## Things not to do

- **Do not sort the document by error code.** The reader does not have one. Sort by
  what they were trying to do.
- **Do not invent a user-facing message.** Quote the message from the facts file or
  describe the condition without quoting anything.
- **Do not describe a rule as tested because a fixture name looks related.** Use
  the fixture mapping in the facts file.
- **Do not soften the coverage gaps.** The placeholder messages and the generic
  catch-all are real, current behaviour. A document that reads as though every
  rejection is clearly explained will be contradicted by the first person who tries
  it.
