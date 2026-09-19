"""Path utilities for the ML package.

All paths are resolved relative to this file's location, not the current working
directory. This ensures consistent behavior when tests are run from different
directories.
"""

from pathlib import Path

# Resolve from this file's location, not cwd
_THIS_FILE = Path(__file__)
REPO_ROOT: Path = _THIS_FILE.parent.parent

# Derived paths
FIXTURES_DIR: Path = REPO_ROOT / "shared" / "fixtures"
MODELS_DIR: Path = REPO_ROOT / "web" / "static" / "models"
CHECKPOINTS_DIR: Path = REPO_ROOT / "ml" / "checkpoints"


def fixture(name: str) -> Path:
    """Get the path to a fixture file by name.

    Args:
        name: The fixture filename (e.g., 'connect4_cases.json')

    Returns:
        Path object to the fixture file

    Raises:
        FileNotFoundError: If the fixture file does not exist

    Example:
        >>> path = fixture('connect4_cases.json')
    """
    path = FIXTURES_DIR / name
    if not path.exists():
        raise FileNotFoundError(
            f"Fixture '{name}' not found at {path}. Expected location: {FIXTURES_DIR}"
        )
    return path
