"""
Plugin entry point.

Registers the Processing provider and adds two menu items, so the tools can be
reached either from the Processing Toolbox or from Plugins > BNG Template
Convert without anyone having to find the Toolbox first.
"""

import os

from qgis.core import QgsApplication
from qgis.PyQt.QtGui import QIcon
from qgis.PyQt.QtWidgets import QAction

from .provider import PROVIDER_ID, BngTemplateProvider

MENU_TITLE = "&BNG Template Convert"
TO_LEGACY_ALGORITHM = f"{PROVIDER_ID}:converttolegacy"
FROM_LEGACY_ALGORITHM = f"{PROVIDER_ID}:convertfromlegacy"


class BngTemplateConvertPlugin:
    def __init__(self, iface):
        self.iface = iface
        self.provider = None
        self.actions = []

    def initProcessing(self):
        self.provider = BngTemplateProvider()
        QgsApplication.processingRegistry().addProvider(self.provider)

    def initGui(self):
        self.initProcessing()
        icon = self._icon()
        for label, algorithm_id in (
            ("Convert to legacy template…", TO_LEGACY_ALGORITHM),
            ("Convert from legacy template…", FROM_LEGACY_ALGORITHM),
        ):
            action = QAction(icon, label, self.iface.mainWindow())
            action.triggered.connect(
                lambda _checked, identifier=algorithm_id: self._run(identifier)
            )
            self.iface.addPluginToMenu(MENU_TITLE, action)
            self.actions.append(action)

    def unload(self):
        if self.provider is not None:
            QgsApplication.processingRegistry().removeProvider(self.provider)
            self.provider = None
        for action in self.actions:
            self.iface.removePluginMenu(MENU_TITLE, action)
        self.actions = []

    def _run(self, algorithm_id):
        # Imported here so the plugin still loads if Processing is unavailable.
        from processing import execAlgorithmDialog

        execAlgorithmDialog(algorithm_id, {})

    def _icon(self):
        path = os.path.join(os.path.dirname(__file__), "icon.svg")
        return QIcon(path) if os.path.exists(path) else QIcon()
