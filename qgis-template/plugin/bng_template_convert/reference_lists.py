"""
The drop-down values the two QGIS templates write differently.

The Natural England template stores some drop-down values with the metric's
own list number in front: "4. Fairly Poor", "2. Retained", "1. Major/Major".
The BNG Service template stores the words alone. Both templates read their
drop-down lists from CSV files in a "CSV References" folder, and this module
reads the same files. A change to a list therefore reaches the converter
without a change to the code.

Two directions:

    service_form   legacy value -> BNG Service value. The number comes off
                   when the words are a value of the list.
    legacy_form    BNG Service value -> legacy value. The number is looked up
                   in the Natural England list, with the same filter the
                   Natural England drop-down uses (for example, the condition
                   list is filtered by habitat type).

A value that is already numbered is not changed by legacy_form, so a file
from an earlier version of the BNG Service template converts as before.

Earlier versions of the BNG Service template numbered their labels as the
Natural England template does. to_template_labels writes the numbered form
that such a template's own lists hold, so old_to_new can fill a copy of it.

WHERE THE LISTS ARE READ FROM
    The plugin zip carries a copy of each list in `reference_lists/`, written
    by build_plugin.py. Run from the repository, the module reads the lists in
    `templates/` directly.
"""

import csv
import os

try:
    from .gpkg_common import NUMBERED_LABEL, plain_label
except ImportError:  # pragma: no cover - running as a plain script
    from gpkg_common import NUMBERED_LABEL, plain_label

SERVICE_TEMPLATE = "bng-service"
LEGACY_TEMPLATE = "legacy-ne"
TEMPLATES = (SERVICE_TEMPLATE, LEGACY_TEMPLATE)

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
BUNDLED_DIR = "reference_lists"
REPOSITORY_TEMPLATES = os.path.join(PACKAGE_DIR, "..", "..", "templates")
CSV_REFERENCES = "CSV References"


def list_folder(template):
    """The folder holding a template's lists: the bundled copy, else the repo's."""
    candidates = (
        os.path.join(PACKAGE_DIR, BUNDLED_DIR, template),
        os.path.join(REPOSITORY_TEMPLATES, template, CSV_REFERENCES),
    )
    for folder in candidates:
        if os.path.isdir(folder):
            return folder
    raise ValueError(
        f"Cannot find the {template} drop-down lists. Looked in "
        f"{' and '.join(os.path.normpath(folder) for folder in candidates)}. "
        "Reinstall the plugin, or run the script from its place in the "
        "repository."
    )


def read_rows(folder, relative_path):
    """Every row of one list in `folder`, as dicts keyed by the CSV header."""
    path = os.path.join(folder, relative_path)
    with open(path, newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def read_list(template, relative_path):
    """Every row of one list of a template."""
    return read_rows(list_folder(template), relative_path)


class LabelList:
    """One drop-down list, as the two templates each store it.

    `service_key` is the column the BNG Service template stores. The legacy
    side is read with `legacy_filter`, the column its drop-down filters on,
    and `legacy_key`, the column it stores. `gaps` gives the legacy value for
    a BNG Service value the Natural England list does not hold in that
    context. `numbered_folder` reads the numbered side from that folder in
    place of the Natural England lists (see stored_in).
    """

    def __init__(self, path, service_key, legacy_filter, legacy_key,
                 gaps=None, numbered_folder=None):
        self.path = path
        self.service_key = service_key
        self.legacy_filter = legacy_filter
        self.legacy_key = legacy_key
        self.gaps = gaps or {}
        self.numbered_folder = numbered_folder
        self._loaded = False
        self._service_values = set()
        self._legacy_by_context = {}
        self._legacy_by_value = {}

    def _load(self):
        if self._loaded:
            return
        for row in read_list(SERVICE_TEMPLATE, self.path):
            value = row.get(self.service_key)
            if value:
                self._service_values.add(value)
        if self.numbered_folder:
            numbered_rows = read_rows(self.numbered_folder, self.path)
        else:
            numbered_rows = read_list(LEGACY_TEMPLATE, self.path)
        for row in numbered_rows:
            label = row.get(self.legacy_key)
            if not label:
                continue
            words = plain_label(label)
            context = row.get(self.legacy_filter)
            self._legacy_by_context.setdefault((context, words), set()).add(label)
            self._legacy_by_value.setdefault(words, set()).add(label)
        self._loaded = True

    def stored_in(self, folder):
        """This list as an earlier BNG Service template stores it.

        `folder` is that template's CSV References folder. Its drop-downs
        filter on the same column as the Natural England ones, and store the
        numbered label in the column the current template stores.
        """
        return LabelList(self.path, self.service_key, self.legacy_filter,
                         self.service_key, self.gaps, numbered_folder=folder)

    def service_form(self, value):
        """The words alone, when they are a value of either template's list."""
        if not isinstance(value, str) or not NUMBERED_LABEL.match(value):
            return value
        self._load()
        words = plain_label(value)
        if words in self._service_values or words in self._legacy_by_value:
            return words
        return value

    def legacy_form(self, value, context):
        """The value as the Natural England list stores it in this context.

        The number is taken from the list row with the same filter value.
        Failing that, from a gap entry, and failing that, from the only
        numbered form the list has for those words. A value the list does not
        know is returned unchanged.
        """
        if not isinstance(value, str) or not value or NUMBERED_LABEL.match(value):
            return value
        self._load()
        labels = self._legacy_by_context.get((context, value))
        if labels and len(labels) == 1:
            return next(iter(labels))
        if value in self.gaps:
            return self.gaps[value]
        labels = self._legacy_by_value.get(value)
        if labels and len(labels) == 1:
            return next(iter(labels))
        return value


# The lists whose stored value carries a number in the Natural England
# template. The other lists store plain words in both templates, as do the
# vertical area habitat lists, which have no legacy layer.
AREA_CONDITION = LabelList(
    "Habitats/Habitat Condition.csv", "Label", "UKHAB", "Label")
WATERCOURSE_CONDITION = LabelList(
    "Watercourses/Watercourse Condition.csv", "Label", "Habitat", "Label")
RIPARIAN_ENCROACHMENT = LabelList(
    "Watercourses/Riparian Encroachment.csv", "Label", "Value", "Label")
# For an existing watercourse, the fourth option of the Natural England list is
# "4. Lost". The BNG Service list puts "Created" in that place, and the Natural
# England list has no "Created" for an existing watercourse. The value keeps
# the number of its place, which is how earlier versions of the BNG Service
# template stored it: "4. Created".
WATERCOURSE_RETENTION = LabelList(
    "Watercourses/Watercourse Retention Options.csv", "Label", "Value",
    "Label", gaps={"Created": "4. Created"})
TREE_CONDITION = LabelList(
    "Individual trees/Individual tree Condition - pre.csv", "Label",
    "Category", "Label")
# Natural England stores a tree's proposed condition from its "New" column,
# which has no numbers. The filter joins the baseline condition, as the
# legacy template stores it, and the retention category.
TREE_PROPOSED_CONDITION = LabelList(
    "Individual trees/Individual tree Condition - options.csv", "Label",
    "ID", "New")

LABEL_LISTS = (
    AREA_CONDITION,
    WATERCOURSE_CONDITION,
    RIPARIAN_ENCROACHMENT,
    WATERCOURSE_RETENTION,
    TREE_CONDITION,
    TREE_PROPOSED_CONDITION,
)


def reference_files():
    """(template, path in its CSV References folder) for every list read here.

    build_plugin.py copies exactly these into the plugin zip.
    """
    return [(template, label_list.path)
            for template in TEMPLATES for label_list in LABEL_LISTS]


# ---------------------------------------------------------------------------
# Which columns use which list, and what the legacy drop-down filters on
# ---------------------------------------------------------------------------

WATERCOURSE_TO_BE_CREATED = "To be created"
TREE_EXISTING = "Existing"
NOT_APPLICABLE = "N/A"


def column(name):
    return lambda row: row.get(name)


def column_or(name, fallback):
    return lambda row: row.get(name) or fallback


def tree_condition_id(row):
    """The legacy filter for a tree's proposed condition: condition + retention.

    Reads the baseline condition after it has been converted, which is why
    that column comes first in COLUMN_LISTS.
    """
    baseline = row.get("Baseline Condition") or NOT_APPLICABLE
    return f"{baseline}{row.get('Retention Category') or ''}"


WATERCOURSE_COLUMNS = (
    ("Baseline Condition", WATERCOURSE_CONDITION, column("Baseline River Type")),
    ("Proposed Condition", WATERCOURSE_CONDITION, column("Proposed River Type")),
    ("Baseline Encroachment into riparian zone", RIPARIAN_ENCROACHMENT,
     column("Baseline River Type")),
    ("Proposed Encroachment into riparian zone", RIPARIAN_ENCROACHMENT,
     column("Proposed River Type")),
    ("Retention Category", WATERCOURSE_RETENTION,
     column_or("Baseline River Type", WATERCOURSE_TO_BE_CREATED)),
)

# Layer -> (column, list, legacy filter value), in the order they must be
# converted. The keys are the staged layer names new_to_old uses, and the
# legacy layer names old_to_new uses, which share their columns.
COLUMN_LISTS = {
    "areas": (
        ("Baseline Condition", AREA_CONDITION, column("Baseline Habitat Type")),
        ("Proposed Condition", AREA_CONDITION, column("Proposed Habitat Type")),
    ),
    "watercourses": WATERCOURSE_COLUMNS,
    "meanders": WATERCOURSE_COLUMNS,
    "trees": (
        ("Baseline Condition", TREE_CONDITION,
         column_or("Category", TREE_EXISTING)),
        ("Proposed Condition", TREE_PROPOSED_CONDITION, tree_condition_id),
    ),
}


def _convert_rows(rows, columns, convert):
    changed = 0
    for row in rows:
        for name, label_list, context in columns:
            if name not in row:
                continue
            value = row[name]
            converted = convert(label_list, value, context(row))
            if converted != value:
                row[name] = converted
                changed += 1
    return changed


def _legacy(label_list, value, context):
    return label_list.legacy_form(value, context)


def _service(label_list, value, _context):
    return label_list.service_form(value)


def to_legacy_labels(layers):
    """Number every listed value in place, as the legacy template stores it.

    `layers` maps a key of COLUMN_LISTS to a list of row dicts, or to a dict
    of such lists by stage. Returns how many values changed.
    """
    return _convert_layers(layers, _legacy)


def to_service_labels(layers):
    """Take the list number off every listed value in place. Returns the count."""
    return _convert_layers(layers, _service)


def template_lists_numbered(folder):
    """Whether the lists in a template's CSV References folder number labels.

    True for an earlier BNG Service template, False for the current one, and
    None when the folder has no condition list to tell by.
    """
    path = os.path.join(folder, AREA_CONDITION.path)
    if not os.path.isfile(path):
        return None
    return any(NUMBERED_LABEL.match(row.get(AREA_CONDITION.service_key) or "")
               for row in read_rows(folder, AREA_CONDITION.path))


def to_template_labels(layers, folder):
    """Number every listed value in place, as the lists in `folder` hold it.

    For filling an earlier BNG Service template, whose lists number their
    labels. Takes the same `layers` as to_legacy_labels, and returns how many
    values changed.
    """
    lists = {}

    def convert(label_list, value, context):
        if label_list.path not in lists:
            lists[label_list.path] = label_list.stored_in(folder)
        return lists[label_list.path].legacy_form(value, context)

    return _convert_layers(layers, convert)


def _convert_layers(layers, convert):
    changed = 0
    for key, columns in COLUMN_LISTS.items():
        stages = layers.get(key)
        if not stages:
            continue
        if isinstance(stages, dict):
            stages = stages.values()
        else:
            stages = (stages,)
        for rows in stages:
            changed += _convert_rows(rows, columns, convert)
    return changed
