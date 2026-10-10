"""`python -m mdium_worker --module <module> [--describe]`."""
from __future__ import annotations

import argparse
import sys

from .worker import run_loop


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mdium_worker")
    parser.add_argument("--module", required=True, help="module that registers the stages")
    parser.add_argument("--describe", action="store_true", help="print the manifest and exit")
    args = parser.parse_args(argv)
    return run_loop(args.module, sys.stdin, sys.stdout, sys.stderr, describe_only=args.describe)


if __name__ == "__main__":
    sys.exit(main())
