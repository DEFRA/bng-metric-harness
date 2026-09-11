"""What conversion to the legacy pair is allowed to change.

This is the list claim 2 is judged against: every value is carried across, or
transformed by a rule written down here. It is written from the documented
behaviour of the conversion, not read out of the converter, because a list
derived from the code it checks would agree with any bug the code contains.

Three kinds of entry, and the checker insists on complete coverage:

  CARRY    the value must arrive unchanged, possibly under another name
  CHANGE   the value must arrive transformed by the named rule
  COMPOSE  a legacy column built from more than one staged column
  DROP     the column has no destination, and why
  INVENT   a legacy column with no source, and where it comes from instead

A staged column absent from all of these, or a legacy column that nothing
accounts for, fails the check on its own. That is deliberate: the failure
mode this guards against is a column quietly appearing or disappearing.
"""

SQ_METRES_PER_HECTARE = 10000

# --- rules -----------------------------------------------------------------


def same(staged, legacy):
    return normalise(staged) == normalise(legacy)


def normalise(value):
    """Blank, missing and whitespace are the same absence of a value."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return value


def hectares_to_whole_sq_metres(staged, legacy):
    """Legacy stores a whole number of square metres; the staged file stores
    hectares. The rounding is the transformation, and it is one way."""
    if staged in (None, ""):
        return legacy in (None, "", 0)
    return int(legacy) == round(float(staged) * SQ_METRES_PER_HECTARE)


def rounded_to_whole(staged, legacy):
    """Lengths and counts, rounded to the whole units legacy stores."""
    if staged in (None, ""):
        return legacy in (None, "", 0)
    return int(legacy) == round(float(staged))


def linear_reference(row, legacy):
    """The reference a derived feature is matched back to its baseline by.

    Legacy resolves an enhanced or retained hedgerow, watercourse or tree to
    its baseline row by matching the reference, so a feature cut from a parent
    has to carry the parent's. A feature created from nothing has no parent,
    and carries its own reference instead.
    """
    parent = normalise(row.get("Parent Ref"))
    own = normalise(row.get("PI Ref"))
    return normalise(legacy) == (parent or own)


def comment_carries(staged, legacy):
    """The comment survives. A lineage note may be appended to it."""
    left, right = normalise(staged), normalise(legacy)
    return right == left or (left in right if left else True)


# --- per layer -------------------------------------------------------------
#
# Each entry is (staged table, legacy table, stage, mapping), where mapping
# holds CARRY/CHANGE/DROP/INVENT as described above.

AREA_BASELINE = {
    "CARRY": {
        "Parcel Ref": "Parcel Ref",
        "Baseline Broad Habitat Type": "Baseline Broad Habitat Type",
        "Baseline Habitat Type": "Baseline Habitat Type",
        "Baseline Distinctiveness": "Baseline Distinctiveness",
        "Baseline Condition": "Baseline Condition",
        "Baseline Strategic Significance": "Baseline Strategic Significance",
    },
    "CHANGE": {
        "Area": ("Area", hectares_to_whole_sq_metres,
                 "hectares to whole square metres"),
        "Comment": ("Comment", comment_carries,
                    "kept, with a lineage note appended when asked for"),
    },
    "DROP": {
        "Irreplaceable Habitat": "the legacy template has no column for it",
        "feature_uuid": "lineage key, and legacy carries no lineage",
    },
    "INVENT": {
        "Location": "site detail, held once on the red line and repeated here",
        "Site Name": "site detail",
        "Survey Date": "site detail",
        "Survey Details": "site detail",
        "Mapped by": "site detail",
        "Company": "site detail",
        "Base Map": "site detail",
        "Retention Category": "empty: a baseline file records no intervention",
        "Proposed Broad Habitat Type": "empty in a baseline file",
        "Proposed Habitat Type": "empty in a baseline file",
        "Proposed Condition": "empty in a baseline file",
        "Proposed Strategic Significance": "empty in a baseline file",
        "Proposed Distinctiveness": "empty in a baseline file",
        "Habitat created in advance/years": "empty in a baseline file",
        "Delay in starting habitat creation/years": "empty in a baseline file",
        "Spatial risk category": "empty in a baseline file",
    },
}

AREA_PI = {
    "CARRY": {
        "PI Ref": "Parcel Ref",
        "Baseline Broad Habitat Type": "Baseline Broad Habitat Type",
        "Baseline Habitat Type": "Baseline Habitat Type",
        "Baseline Distinctiveness": "Baseline Distinctiveness",
        "Baseline Condition": "Baseline Condition",
        "Baseline Strategic Significance": "Baseline Strategic Significance",
        "Retention Category": "Retention Category",
        "Proposed Broad Habitat Type": "Proposed Broad Habitat Type",
        "Proposed Habitat Type": "Proposed Habitat Type",
        "Proposed Distinctiveness": "Proposed Distinctiveness",
        "Proposed Condition": "Proposed Condition",
        "Proposed Strategic Significance": "Proposed Strategic Significance",
        "Habitat created in advance/years": "Habitat created in advance/years",
        "Delay in starting habitat creation/years":
            "Delay in starting habitat creation/years",
        "Spatial risk category": "Spatial risk category",
    },
    "CHANGE": {
        "Area": ("Area", hectares_to_whole_sq_metres,
                 "hectares to whole square metres"),
    },
    "DROP": {
        "Parent Ref": "lineage; recorded in the comment when asked for",
        "Irreplaceable Habitat": "the legacy template has no column for it",
        "parent_uuid": "lineage key",
        "parent_checksum": "lineage key",
        "parent_geom": "lineage: the parent shape, which legacy cannot hold",
    },
    "INVENT": {
        "Location": "site detail", "Site Name": "site detail",
        "Survey Date": "site detail", "Survey Details": "site detail",
        "Mapped by": "site detail", "Company": "site detail",
        "Base Map": "site detail",
        "Comment": "carries the lineage note when asked for",
    },
}

HEDGEROW_BASELINE = {
    "CARRY": {
        "Parcel Ref": "Parcel Ref",
        "Baseline Hedge Type": "Baseline Hedge Type",
        "Baseline Distinctiveness": "Baseline Distinctiveness",
        "Baseline Condition": "Baseline Condition",
        "Baseline Strategic Significance": "Baseline Strategic Significance",
    },
    "CHANGE": {
        "Length": ("Length", rounded_to_whole, "rounded to whole metres"),
        "Comment": ("Comments", comment_carries,
                    "kept, and the column is named Comments here"),
    },
    "DROP": {"feature_uuid": "lineage key"},
    "INVENT": {
        "Location": "site detail", "Site Name": "site detail",
        "Survey Date": "site detail", "Survey Details": "site detail",
        "Mapped by": "site detail", "Company": "site detail",
        "Base Map": "site detail",
        "Retention Category": "empty in a baseline file",
        "Proposed Hedge Type": "empty in a baseline file",
        "Proposed Condition": "empty in a baseline file",
        "Proposed Strategic Significance": "empty in a baseline file",
        "Proposed Distinctiveness": "empty in a baseline file",
        "Habitat created in advance/years": "empty in a baseline file",
        "Delay in starting habitat creation/years": "empty in a baseline file",
        "Spatial risk category": "empty in a baseline file",
    },
}

HEDGEROW_PI = {
    "CARRY": {
        "Baseline Hedge Type": "Baseline Hedge Type",
        "Baseline Distinctiveness": "Baseline Distinctiveness",
        "Baseline Condition": "Baseline Condition",
        "Baseline Strategic Significance": "Baseline Strategic Significance",
        "Retention Category": "Retention Category",
        "Proposed Hedge Type": "Proposed Hedge Type",
        "Proposed Distinctiveness": "Proposed Distinctiveness",
        "Proposed Condition": "Proposed Condition",
        "Proposed Strategic Significance": "Proposed Strategic Significance",
        "Habitat created in advance/years": "Habitat created in advance/years",
        "Delay in starting habitat creation/years":
            "Delay in starting habitat creation/years",
        "Spatial risk category": "Spatial risk category",
    },
    "COMPOSE": {
        "Parcel Ref": (("Parent Ref", "PI Ref"), linear_reference,
                        "the parent's reference, or the feature's own when it\n                         was created from nothing"),
    },
    "CHANGE": {
        "Length": ("Length", rounded_to_whole, "rounded to whole metres"),
    },
    "DROP": {
        "Baseline Length": "held in the baseline file instead",
        "parent_uuid": "lineage key",
        "parent_checksum": "lineage key",
        "parent_geom": "lineage",
    },
    "INVENT": {
        "Location": "site detail", "Site Name": "site detail",
        "Survey Date": "site detail", "Survey Details": "site detail",
        "Mapped by": "site detail", "Company": "site detail",
        "Base Map": "site detail",
        "Comments": "carries the lineage note when asked for",
    },
}

WATERCOURSE_BASELINE = {
    "CARRY": {
        "Parcel Ref": "Parcel Ref",
        "Baseline River Type": "Baseline River Type",
        "Baseline Distinctiveness": "Baseline Distinctiveness",
        "Baseline Condition": "Baseline Condition",
        "Baseline Strategic Significance": "Baseline Strategic Significance",
        "Baseline Encroachment into Watercourse":
            "Baseline Encroachment into Watercourse",
        "Baseline Encroachment into riparian zone":
            "Baseline Encroachment into riparian zone",
    },
    "CHANGE": {
        "Length": ("Length", rounded_to_whole, "rounded to whole metres"),
        "Comment": ("Comments", comment_carries,
                    "kept, and the column is named Comments here"),
    },
    "DROP": {"feature_uuid": "lineage key"},
    "INVENT": {
        "Location": "site detail", "Site Name": "site detail",
        "Survey Date": "site detail", "Survey Details": "site detail",
        "Mapped by": "site detail", "Company": "site detail",
        "Base Map": "site detail",
        "Retention Category": "empty in a baseline file",
        "Proposed River Type": "empty in a baseline file",
        "Proposed Condition": "empty in a baseline file",
        "Proposed Strategic Significance": "empty in a baseline file",
        "Proposed Distinctiveness": "empty in a baseline file",
        "Proposed Encroachment into Watercourse": "empty in a baseline file",
        "Proposed Encroachment into riparian zone": "empty in a baseline file",
        "Enhancement Type": "empty in a baseline file",
        "Habitat created in advance/years": "empty in a baseline file",
        "Delay in starting habitat creation/years": "empty in a baseline file",
        "Spatial risk category": "empty in a baseline file",
    },
}

WATERCOURSE_PI = {
    "CARRY": {
        "Baseline River Type": "Baseline River Type",
        "Baseline Distinctiveness": "Baseline Distinctiveness",
        "Baseline Condition": "Baseline Condition",
        "Baseline Strategic Significance": "Baseline Strategic Significance",
        "Baseline Encroachment into Watercourse":
            "Baseline Encroachment into Watercourse",
        "Baseline Encroachment into riparian zone":
            "Baseline Encroachment into riparian zone",
        "Retention Category": "Retention Category",
        "Proposed River Type": "Proposed River Type",
        "Proposed Distinctiveness": "Proposed Distinctiveness",
        "Proposed Condition": "Proposed Condition",
        "Proposed Strategic Significance": "Proposed Strategic Significance",
        "Proposed Encroachment into Watercourse":
            "Proposed Encroachment into Watercourse",
        "Proposed Encroachment into riparian zone":
            "Proposed Encroachment into riparian zone",
        "Enhancement Type": "Enhancement Type",
        "Habitat created in advance/years": "Habitat created in advance/years",
        "Delay in starting habitat creation/years":
            "Delay in starting habitat creation/years",
        "Spatial risk category": "Spatial risk category",
    },
    "COMPOSE": {
        "Parcel Ref": (("Parent Ref", "PI Ref"), linear_reference,
                        "the parent's reference, or the feature's own when it\n                         was created from nothing"),
    },
    "CHANGE": {
        "Length": ("Length", rounded_to_whole, "rounded to whole metres"),
    },
    "DROP": {
        "Baseline Length": "held in the baseline file instead",
        "parent_uuid": "lineage key",
        "parent_checksum": "lineage key",
        "parent_geom": "lineage",
    },
    "INVENT": {
        "Location": "site detail", "Site Name": "site detail",
        "Survey Date": "site detail", "Survey Details": "site detail",
        "Mapped by": "site detail", "Company": "site detail",
        "Base Map": "site detail",
        "Comments": "carries the lineage note when asked for",
    },
}

TREE_BASELINE = {
    "CARRY": {
        "Tree Ref": "Tree Ref",
        "Baseline Tree Size": "Baseline Tree Size",
        "Baseline Tree Type": "Baseline Tree Type",
        "Baseline Rural or Urban Tree": "Baseline Rural or Urban Tree",
        "Baseline Condition": "Baseline Condition",
        "Baseline Strategic Significance": "Baseline Strategic Significance",
    },
    "CHANGE": {
        "Count": ("Count", rounded_to_whole, "whole trees either way"),
        "Comment": ("Comment", comment_carries, "kept"),
    },
    "DROP": {"feature_uuid": "lineage key"},
    "INVENT": {
        "Location": "site detail", "Site Name": "site detail",
        "Survey Date": "site detail", "Survey Details": "site detail",
        "Mapped by": "site detail", "Company": "site detail",
        "Base Map": "site detail",
        "Retention Category": "empty in a baseline file",
        "Category": "empty in a baseline file",
        "Proposed Tree Size": "empty in a baseline file",
        "Proposed Tree Type": "empty in a baseline file",
        "Proposed Rural or Urban Tree": "empty in a baseline file",
        "Proposed Condition": "empty in a baseline file",
        "Proposed Strategic Significance": "empty in a baseline file",
        "Habitat Created/Enhanced in advance/years": "empty in a baseline file",
        "Delay in starting habitat creation/enhancement in years":
            "empty in a baseline file",
        "Spatial risk category": "empty in a baseline file",
    },
}

TREE_PI = {
    "CARRY": {
        "Baseline Tree Size": "Baseline Tree Size",
        "Baseline Tree Type": "Baseline Tree Type",
        "Baseline Rural or Urban Tree": "Baseline Rural or Urban Tree",
        "Baseline Condition": "Baseline Condition",
        "Baseline Strategic Significance": "Baseline Strategic Significance",
        "Retention Category": "Retention Category",
        "Category": "Category",
        "Proposed Tree Size": "Proposed Tree Size",
        "Proposed Tree Type": "Proposed Tree Type",
        "Proposed Rural or Urban Tree": "Proposed Rural or Urban Tree",
        "Proposed Condition": "Proposed Condition",
        "Proposed Strategic Significance": "Proposed Strategic Significance",
        "Habitat Created/Enhanced in advance/years":
            "Habitat Created/Enhanced in advance/years",
        "Delay in starting habitat creation/enhancement in years":
            "Delay in starting habitat creation/enhancement in years",
        "Spatial risk category": "Spatial risk category",
    },
    "COMPOSE": {
        "Tree Ref": (("Parent Ref", "PI Ref"), linear_reference,
                        "the parent's reference, or the feature's own when it\n                         was created from nothing"),
    },
    "CHANGE": {
        "Count": ("Count", rounded_to_whole, "whole trees either way"),
    },
    "DROP": {
        "parent_uuid": "lineage key",
        "parent_checksum": "lineage key",
        "parent_geom": "lineage",
    },
    "INVENT": {
        "Location": "site detail", "Site Name": "site detail",
        "Survey Date": "site detail", "Survey Details": "site detail",
        "Mapped by": "site detail", "Company": "site detail",
        "Base Map": "site detail",
        "Comment": "carries the lineage note when asked for",
    },
}

# staged table -> (legacy table, stage, mapping, geometry column in legacy)
LAYERS = [
    ("Habitats Baseline", "Habitats", "baseline", AREA_BASELINE, "geom"),
    ("Habitats Post-Intervention", "Habitats", "pi", AREA_PI, "geom"),
    ("Hedgerows Baseline", "Hedgerows", "baseline", HEDGEROW_BASELINE, "geom"),
    ("Hedgerows Post-Intervention", "Hedgerows", "pi", HEDGEROW_PI, "geom"),
    ("Watercourses Baseline", "Rivers", "baseline", WATERCOURSE_BASELINE, "geom"),
    ("Watercourses Post-Intervention", "Rivers", "pi", WATERCOURSE_PI, "geom"),
    ("Trees Baseline", "Urban Trees", "baseline", TREE_BASELINE, "geometry"),
    ("Trees Post-Intervention", "Urban Trees", "pi", TREE_PI, "geometry"),
]

# Rows legacy needs that the staged file does not hold. The staged template
# records a removal by leaving the feature out; legacy has to say so in a row.
SYNTHESISED = {
    "Hedgerows": "Lost", "Rivers": "Lost", "Urban Trees": "Lost",
}

# Whole layers with nowhere to go.
DROPPED_LAYERS = {
    "Vertical Area Habitats Baseline":
        "the legacy template has no vertical area habitat layer",
    "Vertical Area Habitats Post-Intervention":
        "the legacy template has no vertical area habitat layer",
}

# The red line is not a habitat row and does not follow the pattern above.
REDLINE = {
    "CARRY": {"Site Name": "Site Name"},
    "DROP": {
        "Location": "kept on every feature row instead",
        "Survey Date": "kept on every feature row instead",
        "Survey Details": "kept on every feature row instead",
        "Mapped by": "kept on every feature row instead",
        "Company": "kept on every feature row instead",
        "Base Map": "kept on every feature row instead",
    },
    "INVENT": {"Area": "measured from the boundary; legacy has the column"},
}
