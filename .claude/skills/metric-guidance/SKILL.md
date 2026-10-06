---
name: metric-guidance
description: >-
  Answer questions from Defra's Statutory Biodiversity Metric User Guide (June
  2026), held word for word in reference/metric-user-guide/, one file per
  chapter. Use when asked what the metric guidance says, what a rule,
  band, multiplier or definition is (strategic significance, distinctiveness,
  condition, retention/enhancement/creation, advance or delay, spatial risk,
  watercourse or riparian encroachment, trees, IGGI, mosaics, trading rules,
  irreplaceable habitats), or whether the QGIS template or the service follows
  the guidance. Reads the index first and opens only the chapters it needs.
userInvocable: true
arguments: "<question>  — what to look up, or a template/service behaviour to check against the guidance"
---

# Statutory Biodiversity Metric guidance

Answer from the guide, not from memory. The guide is the authority for the
template's columns and the service's checks.

**Where it is:** `reference/metric-user-guide/` in the harness.
`README.md` there is the index: what each chapter covers, how useful it is for
the template or the service, and every section heading.

## Steps

1. **Read the index**, `metric-user-guide/README.md`. Pick the chapter or
   chapters from the table and the section list.
2. **Search before opening.** Grep the folder for the key terms of the
   question (for example `encroachment`, `strategic significance`,
   `tree helper`), with a few lines of context. Then read only the matching
   section of the chosen file, using an offset and limit. Do not read the
   whole folder. Chapters 3, 7, 8 and 10 are over 2,900 words each.
3. **Answer plainly.**
   - Lead with the answer.
   - Give the rule, band or number exactly as the guide states it. A table is
     often clearest.
   - Cite the file and section for each point, for example
     `07-watercourses.md`, "Watercourse encroachment", Table 14.
   - Quote only short phrases. Do not paste whole sections.
4. **If asked to check the template or the service**, find the matching
   implementation and compare:
   - template drop-down lists (the `template` symlink points at the
     bng-metric-template sibling repo):
     `template/templates/bng-service/CSV References/`
   - template defaults and locked columns:
     `template/development/tools/set_field_rules.py`,
     `reset_stale_dropdowns.py`, `paste_lineage.py`
   - conversion to Natural England and the Metric:
     `template/plugin/bng_template_convert/`
   - service checks: `backend/src/validation/`

   State whether they agree. Name any gap with the file and line on each side.

## Things to keep in mind

- **The service assumes every local planning authority has published its
  Local Nature Recovery Strategy (LNRS).** It follows the "LNRS has been
  published" rules and Table 7 in `04-habitat-quality-inputs.md`. Baseline
  strategic significance is always Low; post-intervention is Low or High;
  Medium is not used. Table 8 (no LNRS yet) is kept for reference only. Say so
  when an answer touches strategic significance.
- **The only text added to the guide** is the blockquote that starts
  "BNG Service note (not part of the guidance)". Never present it as Defra's
  wording.
- **Figures are placeholders.** `[Figure: …]` marks an image the copy cannot
  hold. When an answer depends on a figure, say that the figure is not in the
  text, and point to the PDF page via the chapter's position in
  `00-front-matter.md` (Contents).
- **The text keeps the guide's own typos** (for example "proving a running
  total"). Do not correct them in quotes.
- **Licence:** Crown copyright, Open Government Licence v3.0. The licence text
  is in `00-front-matter.md`.
- If the guide does not cover the question, say so. Do not fill the gap from
  general knowledge without saying that it is not from the guide.
