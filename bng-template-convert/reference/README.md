# reference

The Natural England files this repository converts to and from, kept here so
a test can be run without hunting for them.

| File | What it is |
| --- | --- |
| `The_Statutory_Metric_Macro_Enabled_1.0.4.xlsm` | The Statutory Biodiversity Metric. `to_metric.py` fills a copy of this |
| `GIS Import Tool.xlsb` | The Excel tool that reads the three CSVs `new_to_old.py --format csv` writes |
| `Biodiversity Metric and SSM - GIS tools User Guide.pdf` | Natural England's guidance for both, and the source of the rules quoted around this repository |

**These are inputs, never outputs.** Nothing here writes to them: the metric
export reads the workbook and writes a filled copy elsewhere, and refuses to
run at all if the workbook it is given already holds a site.

## The two numbers from the guidance that shape everything

**248 rows.** Both the import tool and each sheet of the metric hold that
many (User Guide 3.1.5). A site larger than that has to be split into
geographic sections or have its rows merged, and a nationally significant
project needs both.

**Consolidation loses the audit trail** (3.2.3). Merging rows that share every
attribute is arithmetically free, because units are linear in size and merged
rows share every multiplier, but an individual polygon can no longer be traced
through to the metric. That is a choice for the user, which is why it is an
option and not the default.
