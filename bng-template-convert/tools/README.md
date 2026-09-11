# tools

Editing the Python actions that live inside a QGIS project.

The template's four attribute-table buttons are Python scripts stored as XML
attributes in the `.qgz`. Rewriting one through `QgsProject.write()` is the
obvious route and the wrong one: it drops action shortTitles set in XML, and
it rewrites three megabytes of project for the sake of one attribute.

`qgz_actions.py` edits the attribute in place instead. Its escaping is
verified by round-tripping: unescaping and re-escaping every one of the
project's twenty action bodies reproduces the original bytes exactly. Two
things had to be right for that, and both are easy to get wrong. QGIS leaves
`>` unescaped in an attribute, and an action body ends at the first raw double
quote after `action="`, not at whatever attribute happens to come next: some
actions carry an `<actionScope>` child and some do not.

| File | What |
| --- | --- |
| `qgz_actions.py` | Read and rewrite action bodies in a `.qgz`, byte-safely |
| `speed_up_copy_action.py` | The one-off that made the copy action batched and interruptible |

`speed_up_copy_action.py` has already been applied to
`templates/bng-service`. It is kept so it can be applied to a working copy
made before the change, including a live master held outside this repository.
It expects the old body and stops without writing if it does not find it, so a
second run is harmless.

```sh
python3 tools/speed_up_copy_action.py "path/to/BNG Service Habitat Mapping.qgz"
```

It writes a timestamped `.backup-YYYYMMDD-HHMMSS` beside the project before
changing anything.
