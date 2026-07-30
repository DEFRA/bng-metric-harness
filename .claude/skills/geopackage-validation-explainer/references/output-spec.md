# Output specification — `geopackage-validation-explained.md`

The document is **assembled by `build-document.mjs`**, not written by the model. This file therefore specifies two things: the shape of the document the script produces, and the house style for the one thing a human or a model still authors — the `checks` text in `references/rule-descriptions.json`.

An earlier version of this skill had the model write the whole document on every run. That cost 20–40 minutes, produced several thousand words of prose nobody asked for, and reworded everything even when the code had not changed. If you are tempted to reintroduce narrative sections, read the runtime note in `SKILL.md` first.

## Audience

A knowledgeable non-programmer — an ecologist, planning consultant or product owner. They understand biodiversity net gain and work in a GIS package. They do not read JavaScript and should never need to.

## Shape of the document

Fixed, and owned by the script. In order:

1. Title and a one-line statement of what the document is.
2. A provenance paragraph: generated, how to regenerate, the three commits, the date.
3. A link to `rules-engine-explained.md` for the calculation side.
4. **How to read this** — the reject-versus-Incomplete distinction, the two-rounds warning, the on-screen-message caveat, and what the example-file paths refer to.
5. **The rules** — the substance. One subsection per group, each a two-column table.
6. **Coverage** — counts, all from the facts file.
7. **Known gaps recorded by this run.**
8. **Where this comes from** — the three repositories and commits.

Nothing else. No remedy sections, no GIS tutorials, no "things that surprise people" essay. A rule's description says what it checks; what to do about it is the error page's job and the service's content design, not this document's.

## The table

Two columns, and the left one carries both identifiers:

| Column | Contents |
| --- | --- |
| Rule and example file | The error code, then the path of the `.gpkg` under `example-files/` that demonstrates it — or `no geopackage fixture`. Several paths are separated by a semicolon. |
| What it checks | The `checks` text, followed by one generated sentence saying whether the user sees its own message, a placeholder, or a generic message. |

**No `<br>`, so both parts of the left cell sit on one line** separated by an em dash, with the path in italics. A raw `<br>` renders as literal text in Confluence, which is the document's final destination.

Row order within a group follows `rule-descriptions.json`, not the registry. The registry is ordered by how the code grew, which puts "the same rule, for this layer" rows ahead of the general rule they refer back to.

## Writing a `checks` description

This is the only prose that needs authoring, and only for a code that has no entry yet.

- **One or two sentences.** State the condition that triggers the rule. Stop.
- **No code.** No function names, file paths, table names or SQL. The error code appears in the left column; it does not belong in the sentence.
- **Name what the reader sees**, not what the system calls it: "the red line boundary is missing", not the identifier.
- **Include the tolerance** where there is one, in the reader's units — square metres, metres, square kilometres — and say what passes as well as what fails. A reader who does not know that a 0.4 m² overlap is accepted will chase a fault the service never raised.
- **No remedies.** They belong to the error page, and they tripled the length of the previous version.
- **Do not describe what the user is told.** The script generates that sentence from the facts file, so a hand-written claim about it will contradict the data the moment the copy changes.
- **Say when a rule appears unreachable** rather than describing it as though users hit it.
- **Keep statutory terms intact.** *Distinctiveness*, *condition* and *red line boundary* come from the Natural England metric; explain them plainly but do not rename them.

## Groups

Set by the `group` field, ordered by `GROUP_ORDER` in `build-document.mjs`. A group not listed there is appended alphabetically, which is the signal to decide where it really belongs.

Groups follow the order a file is actually checked in — format, then layers, columns and coordinate system, then shapes, then how the shapes fit together, then habitat data — so the table doubles as a description of the pipeline. The final group covers failures that are not the reader's fault at all.

## Formatting rules

**Confluence is the final destination**, so it wins every trade-off.

- Tables for everything enumerable. They are the one rich construct that survives every renderer.
- **No HTML tags at all.**
- No nested bullet lists deeper than one level; Confluence's paste conversion mangles them.
- No Mermaid. The previous version considered it; a two-column table needs no diagram.
- Pipe characters in a fixture path are escaped by the script. Do not hand-edit a path into the descriptions file.
