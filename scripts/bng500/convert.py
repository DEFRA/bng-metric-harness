#!/usr/bin/env python3
"""
Convert a legacy BNG500 pair into a BNG Service template file with the
template's own converter (plugin/bng_template_convert/old_to_new.py in the
bng-metric-template sibling), reproducibly.

The converter gives every baseline feature a fresh uuid4, so two runs differ.
This runs it with those uuids drawn from a seeded generator instead; nothing
else in the conversion changes. The caller (scripts/service-template/
convert.mjs) runs it with PYTHONHASHSEED=0, then fixes the timestamps SQLite
writes and rewrites the file with VACUUM, so the result is the same bytes on
every run.

    python3 convert.py --converter-dir DIR --seed N \
        --baseline BASE.gpkg --post-intervention PI.gpkg --out OUT.gpkg

Anything the converter prints goes to stderr; stdout stays empty. Exits 1
if the conversion fails.
"""

import argparse
import contextlib
import random
import sys
import uuid

UUID_BITS = 128
UUID_VERSION = 4


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--converter-dir", required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--post-intervention", required=True)
    parser.add_argument("--out", required=True)
    return parser.parse_args(argv)


def seeded_uuids(seed):
    """A uuid4-shaped id drawn from a generator seeded with `seed`."""
    rng = random.Random(seed)
    return lambda: str(
        uuid.UUID(int=rng.getrandbits(UUID_BITS), version=UUID_VERSION)
    )


def main(argv=None):
    args = parse_args(argv)
    sys.path.insert(0, args.converter_dir)
    import old_to_new  # noqa: E402 - found through --converter-dir

    old_to_new.new_uuid = seeded_uuids(args.seed)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            old_to_new.convert(
                args.baseline,
                args.post_intervention,
                None,
                None,
                False,
                False,
                out_file=args.out,
            )
    except Exception as error:  # the converter's own errors, reported plainly
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
