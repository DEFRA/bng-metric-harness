"""
Processing algorithms wrapping the two converters.

The conversion logic lives in new_to_old.py / old_to_new.py, which are plain
Python and run equally well from a command line. These classes only translate
between the Processing dialog and those functions, and add the guards that only
make sense when running inside QGIS — chiefly, refusing to read a GeoPackage
whose edits are still sitting unsaved in the map.
"""

import os

from qgis.core import (
    QgsProcessingAlgorithm,
    QgsProcessingException,
    QgsProcessingParameterBoolean,
    QgsProcessingParameterFile,
    QgsProcessingParameterFileDestination,
    QgsProcessingParameterFolderDestination,
    QgsProject,
    QgsVectorLayer,
)

from . import new_to_old, old_to_new

GEOPACKAGE_FILTER = "GeoPackage (*.gpkg *.GPKG)"
SOURCE_SEPARATOR = "|"


def _layer_file(layer):
    """The GeoPackage path behind a layer, or None."""
    source = layer.source() or ""
    path = source.split(SOURCE_SEPARATOR, 1)[0]
    return os.path.normpath(path) if path else None


def _same_file(left, right):
    if not left or not right:
        return False
    try:
        return os.path.samefile(left, right)
    except OSError:
        return os.path.normpath(left) == os.path.normpath(right)


def _layers_for_file(path):
    """Every vector layer in the current project backed by this file."""
    matches = []
    for layer in QgsProject.instance().mapLayers().values():
        if not isinstance(layer, QgsVectorLayer):
            continue
        if _same_file(_layer_file(layer), path):
            matches.append(layer)
    return matches


def require_saved_edits(path, feedback):
    """Stop if any layer from this file still has unsaved edits.

    Committed edits are safe to read even before QGIS folds them back into the
    GeoPackage: they live in the file's write-ahead log, and the converters
    open the file in a mode that reads it. Edits still sitting in a layer's
    edit buffer, though, exist only in memory and would be silently missed.
    """
    unsaved = [
        layer.name()
        for layer in _layers_for_file(path)
        if layer.isEditable() and layer.isModified()
    ]
    if unsaved:
        raise QgsProcessingException(
            "These layers have unsaved edits, which would be missing from the "
            "conversion:\n  - "
            + "\n  - ".join(unsaved)
            + "\n\nSave them first (Layer > Save Layer Edits, or the Save "
            "button on the Digitising toolbar), then run this again."
        )
    feedback.pushInfo(f"Reading: {path}")


def refuse_open_target(path, feedback):
    """Stop if the file we are about to write into is open in this project."""
    open_layers = [layer.name() for layer in _layers_for_file(path)]
    if open_layers:
        raise QgsProcessingException(
            f"{os.path.basename(path)} is open in this project "
            f"({len(open_layers)} layer(s)), so it cannot be written to safely."
            "\n\nRun this from a different project — for example a new empty "
            "one — and open the template project afterwards to see the result."
        )


def report_to_feedback(report, feedback):
    """Show a converter's report in the Processing log."""
    feedback.pushInfo("")
    feedback.pushInfo("Rows written")
    for key, value in report.counts.items():
        feedback.pushInfo(f"    {key}: {value}")

    if report.lines:
        feedback.pushInfo("")
        feedback.pushInfo("What happened")
        for line in report.lines:
            feedback.pushInfo(f"    - {line}")

    if report.warnings:
        feedback.pushInfo("")
        for line in report.warnings:
            feedback.pushWarning(f"CHECK THIS: {line}")


class ConvertToLegacyAlgorithm(QgsProcessingAlgorithm):
    """BNG Service GeoPackage -> the legacy baseline + post-intervention pair."""

    INPUT = "INPUT"
    OUTPUT_FOLDER = "OUTPUT_FOLDER"
    CARRY_LINEAGE = "CARRY_LINEAGE"

    def flags(self):
        # Reads QgsProject to check for unsaved edits, which is main-thread only.
        return super().flags() | QgsProcessingAlgorithm.FlagNoThreading

    def name(self):
        return "converttolegacy"

    def displayName(self):
        return "Convert to legacy template (for the older service)"

    def group(self):
        return "BNG template conversion"

    def groupId(self):
        return "bngtemplate"

    def shortHelpString(self):
        return (
            "<p>Takes the single GeoPackage used by the <b>BNG Service "
            "template</b> and writes the <b>two</b> GeoPackages the older "
            "Biodiversity Metric service expects — a baseline file and a "
            "post-intervention file, which you upload one after the other."
            "</p>"
            "<p><b>Save your edits first.</b> Anything still unsaved in the "
            "map cannot be converted, and this tool will stop and tell you "
            "which layers to save.</p>"
            "<p><b>Things the legacy format cannot hold</b> are listed as "
            "warnings when the tool finishes — read them. Vertical area "
            "habitats in particular have no legacy layer at all, so their "
            "biodiversity units will be missing from the legacy calculation."
            "</p>"
            "<p><i>Record lineage in comments</i> writes each feature's parent "
            "reference into the legacy Comment column. The older service "
            "ignores it, but it lets the companion tool restore the links "
            "exactly if you ever convert back. Leave it ticked unless you need "
            "the comment column untouched.</p>"
        )

    def initAlgorithm(self, config=None):
        self.addParameter(
            QgsProcessingParameterFile(
                self.INPUT,
                "BNG Service GeoPackage (usually Layers/BNG Service Layers.gpkg)",
                behavior=QgsProcessingParameterFile.File,
                fileFilter=GEOPACKAGE_FILTER,
            )
        )
        self.addParameter(
            QgsProcessingParameterFolderDestination(
                self.OUTPUT_FOLDER, "Folder to put the two legacy files in"
            )
        )
        self.addParameter(
            QgsProcessingParameterBoolean(
                self.CARRY_LINEAGE,
                "Record lineage in comments (recommended)",
                defaultValue=True,
            )
        )

    def processAlgorithm(self, parameters, context, feedback):
        source = self.parameterAsFile(parameters, self.INPUT, context)
        out_dir = self.parameterAsString(parameters, self.OUTPUT_FOLDER, context)
        carry = self.parameterAsBool(parameters, self.CARRY_LINEAGE, context)

        if not source or not os.path.exists(source):
            raise QgsProcessingException(f"Cannot find the input file: {source}")
        require_saved_edits(source, feedback)

        feedback.pushInfo("Converting to the legacy template…")
        report = new_to_old.convert(source, out_dir, carry, False)
        report_to_feedback(report, feedback)

        feedback.pushInfo("")
        feedback.pushInfo(
            "Next: upload the Baseline file first, then the Post-Intervention "
            "file."
        )
        return {self.OUTPUT_FOLDER: out_dir}

    def createInstance(self):
        return ConvertToLegacyAlgorithm()


class ConvertFromLegacyAlgorithm(QgsProcessingAlgorithm):
    """The legacy pair -> a single BNG Service GeoPackage."""

    BASELINE = "BASELINE"
    POST_INTERVENTION = "POST_INTERVENTION"
    TEMPLATE = "TEMPLATE"
    OUTPUT_FILE = "OUTPUT_FILE"

    def flags(self):
        # Reads QgsProject to check for unsaved edits, which is main-thread only.
        return super().flags() | QgsProcessingAlgorithm.FlagNoThreading

    def name(self):
        return "convertfromlegacy"

    def displayName(self):
        return "Convert from legacy template (into the BNG Service template)"

    def group(self):
        return "BNG template conversion"

    def groupId(self):
        return "bngtemplate"

    def shortHelpString(self):
        return (
            "<p>Joins a legacy <b>baseline</b> and <b>post-intervention</b> "
            "GeoPackage back into the single GeoPackage the BNG Service "
            "template uses.</p>"
            "<p><b>The usual way to use this:</b> copy the whole BNG Service "
            "Template folder for your site, then set <i>Existing template "
            "GeoPackage to fill</i> to the copy's "
            "<i>Layers/BNG Service Layers.gpkg</i>. Open that copy's project "
            "afterwards and your habitats are there, with all the template's "
            "styling and drop-downs. Leave it blank instead to get a plain new "
            "GeoPackage.</p>"
            "<p><b>Lineage.</b> The legacy files never recorded which baseline "
            "feature each post-intervention feature came from. This tool links "
            "what it can prove — matching references, or breadcrumbs left by "
            "the companion tool — and deliberately leaves the rest blank so "
            "the service works them out from the shapes and tells you which "
            "ones it guessed. The log says how many were linked.</p>"
            "<p><b>Afterwards you must</b> fill in Irreplaceable Habitat (no "
            "legacy column exists) and add any vertical area habitats such as "
            "green walls.</p>"
        )

    def initAlgorithm(self, config=None):
        self.addParameter(
            QgsProcessingParameterFile(
                self.BASELINE,
                "Legacy baseline GeoPackage",
                behavior=QgsProcessingParameterFile.File,
                fileFilter=GEOPACKAGE_FILTER,
            )
        )
        self.addParameter(
            QgsProcessingParameterFile(
                self.POST_INTERVENTION,
                "Legacy post-intervention GeoPackage (leave blank for baseline only)",
                behavior=QgsProcessingParameterFile.File,
                fileFilter=GEOPACKAGE_FILTER,
                optional=True,
            )
        )
        self.addParameter(
            QgsProcessingParameterFile(
                self.TEMPLATE,
                "Existing template GeoPackage to fill (recommended)",
                behavior=QgsProcessingParameterFile.File,
                fileFilter=GEOPACKAGE_FILTER,
                optional=True,
            )
        )
        self.addParameter(
            QgsProcessingParameterFileDestination(
                self.OUTPUT_FILE,
                "…or write a new GeoPackage here",
                fileFilter=GEOPACKAGE_FILTER,
                optional=True,
                createByDefault=False,
            )
        )

    def processAlgorithm(self, parameters, context, feedback):
        baseline = self.parameterAsFile(parameters, self.BASELINE, context)
        post = self.parameterAsFile(parameters, self.POST_INTERVENTION, context)
        template = self.parameterAsFile(parameters, self.TEMPLATE, context)
        destination = self.parameterAsString(parameters, self.OUTPUT_FILE, context)

        if not baseline or not os.path.exists(baseline):
            raise QgsProcessingException(
                f"Cannot find the baseline file: {baseline}"
            )
        if not template and not destination:
            raise QgsProcessingException(
                "Choose either an existing template GeoPackage to fill, or a "
                "place to write a new GeoPackage."
            )
        if template and destination:
            feedback.pushWarning(
                "Both an existing template and a new file were given — filling "
                "the existing template and ignoring the new file."
            )

        require_saved_edits(baseline, feedback)
        if post:
            require_saved_edits(post, feedback)
        else:
            feedback.pushInfo(
                "No post-intervention file given — converting the baseline only."
            )

        if template:
            refuse_open_target(template, feedback)
            feedback.pushInfo(f"Filling: {template}")
            report = old_to_new.convert(
                baseline, post or None, ".", template, False, False
            )
        else:
            feedback.pushInfo(f"Writing: {destination}")
            report = old_to_new.convert(
                baseline,
                post or None,
                os.path.dirname(destination) or ".",
                None,
                False,
                False,
                out_file=destination,
            )

        report_to_feedback(report, feedback)
        feedback.pushInfo("")
        feedback.pushInfo(
            "Next: open the template project, check the parent links, fill in "
            "Irreplaceable Habitat, and add any vertical area habitats."
        )
        return {self.OUTPUT_FILE: template or destination}

    def createInstance(self):
        return ConvertFromLegacyAlgorithm()


ALGORITHMS = (ConvertToLegacyAlgorithm, ConvertFromLegacyAlgorithm)
