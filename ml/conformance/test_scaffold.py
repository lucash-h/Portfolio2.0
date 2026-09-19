"""Scaffold test proving the test harness is functional.

This is a trivial test with no assertions other than not raising an exception.
Its sole purpose is to verify that pytest can collect and run tests in the ml/
package, and that imports work correctly.
"""

import ml.paths


def test_scaffold_passes() -> None:
    """Trivial passing test to prove the harness works."""
    # Verify that paths module is importable and has expected attributes
    assert hasattr(ml.paths, "REPO_ROOT")
    assert hasattr(ml.paths, "FIXTURES_DIR")
    assert hasattr(ml.paths, "MODELS_DIR")
    assert hasattr(ml.paths, "CHECKPOINTS_DIR")
    assert hasattr(ml.paths, "fixture")

    # Verify paths are sensible Path objects
    assert ml.paths.REPO_ROOT.is_dir()
    assert ml.paths.CHECKPOINTS_DIR.parent.is_dir()
