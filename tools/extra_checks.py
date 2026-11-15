# =============================================================================
# HYDRA-UMC-SERVER - tools/extra_checks.py
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
# GPL-3.0-or-later - see LICENSE
# =============================================================================
"""The checks of this repository beyond the shared ones: the two pictures of the README and the file tree.

`docs/architecture.json` draws `images/architecture.svg` and `docs/structure.json` draws `images/repository-structure.svg` and the text tree of the eight
READMEs; both checks fail when the picture, the JSON or the code it points to disagree (see docs/README_PICTURES.md of the A.R.M.O.R. common repository for the tools).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

CHECKS = (
    ("make_architecture.py", ["--check"]),
    ("make_structure.py", ["--check", "--readmes"]),
)


def check(root: Path) -> list[str]:
    problems: list[str] = []
    for script, arguments in CHECKS:
        path = root / "tools" / script
        if not path.is_file() or not (root / "docs" / ("architecture.json" if "architecture" in script else "structure.json")).is_file():
            continue
        result = subprocess.run([sys.executable, "-I", str(path), *arguments],
                                cwd=root, text=True, encoding="utf-8", errors="replace", capture_output=True, check=False)
        if result.returncode != 0:
            problems.append(f"tools/{script} {' '.join(arguments)}: " + (result.stdout + result.stderr).strip().splitlines()[-1][:300])
    problems.extend(_dist_cases())
    problems.extend(dist_version_problems(root)[1])
    problems.extend(dist_workflow_problems(root))
    return problems


# --- the version of the production-files build -------------------------------------------------------------------------------------------------
# The manifest (hydra-umc.project.json) carries the version of the program, with three or four components. package.json (and package-lock.json) can
# only carry three, so they must equal the FIRST THREE components of the manifest version. Used by .github/workflows/dist-build.yml (step "Work out
# the version and pin the commit") and checked, with its own cases, by check().

VERSION_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$")
DIST_WORKFLOW = Path(".github") / "workflows" / "dist-build.yml"
DIST_CALL = "tools/extra_checks.py dist-version"


def package_version_for(version: str) -> str:
    """The three-component version npm accepts for a manifest version of three or four components."""
    return ".".join(version.split(".")[:3])


def _read_json(path: Path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def dist_version_problems(root: Path) -> tuple[str, list[str]]:
    """(manifest version, problems): package.json holds its first three components and package-lock.json agrees with package.json."""
    problems: list[str] = []
    try:
        version = str(_read_json(root / "hydra-umc.project.json")["version"])
    except (OSError, ValueError, KeyError) as error:
        return "", [f"hydra-umc.project.json has no readable version ({error.__class__.__name__})"]
    if not VERSION_PATTERN.match(version):
        problems.append(f"the version {version} is not one the updater accepts")
        return version, problems
    wanted = package_version_for(version)
    try:
        package = str(_read_json(root / "package.json")["version"])
    except (OSError, ValueError, KeyError) as error:
        return version, problems + [f"package.json has no readable version ({error.__class__.__name__})"]
    if package != wanted:
        problems.append(f"package.json says {package}, the manifest says {version} (package.json must say {wanted})")
    lock_path = root / "package-lock.json"
    if lock_path.is_file():
        try:
            lock = _read_json(lock_path)
            top = str(lock["version"])
            inner = str(lock["packages"][""]["version"])
        except (OSError, ValueError, KeyError, TypeError) as error:
            return version, problems + [f"package-lock.json has no readable version ({error.__class__.__name__})"]
        if top != package or inner != package:
            problems.append(f"package-lock.json says {top} / {inner}, package.json says {package}")
    return version, problems


def _dist_cases() -> list[str]:
    """Run the check on made-up folders: three components equal, four components with a three-component package.json, and the ways it must fail."""
    cases = (
        ("0.8.2", "0.8.2", "0.8.2", "0.8.2", True),
        ("0.8.2.2", "0.8.2", "0.8.2", "0.8.2", True),
        ("0.8.2.2", "0.8.3", "0.8.3", "0.8.3", False),
        ("0.8.2.2", "0.8.2.2", "0.8.2.2", "0.8.2.2", False),
        ("0.8.2", "0.8.1", "0.8.1", "0.8.1", False),
        ("0.8.2.2", "0.8.2", "0.8.1", "0.8.2", False),
        ("0.8.2.2", "0.8.2", "0.8.2", "0.8.1", False),
        ("0.8", "0.8.0", "0.8.0", "0.8.0", False),
    )
    problems: list[str] = []
    for manifest, package, lock_top, lock_inner, good in cases:
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            (base / "hydra-umc.project.json").write_text(json.dumps({"version": manifest}), encoding="utf-8")
            (base / "package.json").write_text(json.dumps({"version": package}), encoding="utf-8")
            (base / "package-lock.json").write_text(json.dumps({"version": lock_top, "packages": {"": {"version": lock_inner}}}), encoding="utf-8")
            found = dist_version_problems(base)[1]
        if bool(found) == good:
            problems.append(f"dist-build version check: manifest {manifest}, package.json {package}, lock {lock_top}/{lock_inner} should {'pass' if good else 'fail'}")
    return problems


def dist_workflow_problems(root: Path) -> list[str]:
    """The production-files workflow must use this check and must not compare package.json with the whole manifest version again."""
    path = root / DIST_WORKFLOW
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8")
    problems: list[str] = []
    if DIST_CALL not in text:
        problems.append(f"{DIST_WORKFLOW.as_posix()} must run `{DIST_CALL}` to compare package.json with the manifest")
    if '[ "$pkg" = "$version" ]' in text:
        problems.append(f"{DIST_WORKFLOW.as_posix()} compares package.json with the whole manifest version, which has four components")
    return problems


def main(arguments: list[str]) -> int:
    if arguments[:1] == ["dist-version"]:
        root = Path(arguments[1]) if len(arguments) > 1 else Path.cwd()
        version, problems = dist_version_problems(root)
        for problem in problems:
            print(f"::error::{problem}")
        if not problems:
            print(f"package.json and package-lock.json agree with the manifest version {version}")
        return 1 if problems else 0
    print("usage: extra_checks.py dist-version [folder]", file=sys.stderr)
    return 0 if arguments[:1] in (["--help"], ["-h"]) else 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
