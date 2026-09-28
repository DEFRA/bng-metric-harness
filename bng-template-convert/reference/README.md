# reference

The Natural England files that the converter reads, kept here so that a test
can run without a download.

| File | What it is |
| --- | --- |
| `The_Statutory_Metric_Macro_Enabled_1.0.4.xlsm` | The Statutory Biodiversity Metric. `to_metric.py` fills a copy of it |
| `The_Statutory_Metric_Macro_Disabled_1.0.4.xlsx` | The same Metric without macros. The sheets, formulas and cells are the same, so `to_metric.py` fills it in the same way and writes an `.xlsx` |
| `GIS Import Tool.xlsb` | The Excel tool that reads the three CSV files from `new_to_old.py --format csv` |
| `Biodiversity Metric and SSM - GIS tools User Guide.pdf` | The Natural England guidance for both tools, and the source of the rules that these documents quote |

**These files are inputs only.** The Metric export writes a filled copy to a
different location. It does not run if the workbook already holds a site,
unless `--allow-occupied` is given.

## Two limits from the guidance

**Each sheet holds 248 rows.** This applies to the import tool and to each
sheet of the Metric (User Guide 3.1.5). A larger site must be divided into
geographic sections or have its rows merged. An NSIP needs both.

**Consolidation removes the audit trail** (User Guide 3.2.3). The merge of
rows that share all attributes does not change the units, because units are
linear in size and the merged rows share all multipliers. But a single polygon
can then not be traced into the Metric. For this reason consolidation is an
option, not the default.
