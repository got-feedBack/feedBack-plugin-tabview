import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# rs2gp.py imports `from song import arrangement_string_count` at module
# top-level — `song` is a host-provided lib module (lib/song.py, loaded via
# the desktop app's sys.path setup at runtime), not something this plugin
# repo ships or that's pip-installable. Stub just the one symbol rs2gp
# actually uses so the module — and the pure helper functions we're
# testing — can be imported standalone in CI.
if "song" not in sys.modules:
    stub = types.ModuleType("song")
    stub.arrangement_string_count = lambda arr: 6
    sys.modules["song"] = stub
