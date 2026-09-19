"""Pytest configuration for the ML package.

This module configures pytest fixtures and settings for all tests in the ml/
package. It makes the paths module and fixtures_dir available to all tests.
"""

import pytest

from ml.paths import FIXTURES_DIR


@pytest.fixture
def fixtures_dir():
    """Provide the path to the shared fixtures directory.

    This fixture returns the Path object for shared/fixtures/, which contains
    language-neutral JSON test vectors used by both TypeScript and Python tests
    to ensure parity between implementations.

    Returns:
        Path: The fixtures directory path
    """
    return FIXTURES_DIR
