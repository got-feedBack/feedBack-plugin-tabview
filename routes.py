"""Tab View plugin — serves Guitar Pro files converted from Rocksmith arrangements."""

import sys
import tempfile
from pathlib import Path
from fastapi import FastAPI
from fastapi.responses import Response

# Ensure Rocksmith lib is importable
_lib = str(Path(__file__).resolve().parent.parent.parent / "lib")
if _lib not in sys.path:
    sys.path.insert(0, _lib)

# `sloppak` is loaded lazily inside the .sloppak branch below — older
# cores ship without lib/sloppak.py, and a top-level import here would
# disable Tab View entirely on those installs.


def setup(app: FastAPI, context: dict):
    get_dlc_dir = context["get_dlc_dir"]
    get_sloppak_cache = context.get("get_sloppak_cache_dir")

    from rs2gp import rocksmith_to_gp5

    def _song_to_gp5(song, arrangement: int) -> Response:
        if not song.arrangements:
            return Response("No arrangements found", status_code=404)
        idx = max(0, min(arrangement, len(song.arrangements) - 1))
        gp5_bytes = rocksmith_to_gp5(song, idx)
        return Response(
            content=gp5_bytes,
            media_type="application/octet-stream",
            headers={"Content-Disposition": 'attachment; filename="tab.gp5"'},
        )

    @app.get("/api/plugins/tabview/gp5/{filename:path}")
    def tabview_gp5(filename: str, arrangement: int = 0):
        dlc = get_dlc_dir()
        if not dlc:
            return Response("DLC folder not configured", status_code=500)

        psarc_path = Path(dlc) / filename

        # Path traversal guard: reject any filename that resolves outside dlc.
        dlc_resolved = Path(dlc).resolve()
        try:
            resolved = psarc_path.resolve()
        except Exception:
            return Response("Path resolution failed", status_code=400)
        if resolved != dlc_resolved and dlc_resolved not in resolved.parents:
            return Response("Path traversal not allowed", status_code=400)

        if not psarc_path.exists():
            return Response("File not found", status_code=404)

        try:
            # Sloppak (zip-form *.sloppak or directory-form *.sloppak/): use
            # the sloppak loader directly. Only directories whose name ends
            # with ".sloppak" are treated as sloppaks; any other input is
            # rejected with a clear error below.
            is_sloppak = filename.lower().endswith(".sloppak") or (
                psarc_path.is_dir() and psarc_path.name.lower().endswith(".sloppak")
            )
            if is_sloppak:
                try:
                    import sloppak as sloppak_mod
                except ImportError:
                    return Response(
                        "Sloppak support requires a newer Slopsmith core (lib/sloppak.py). "
                        "Update the host.",
                        status_code=501,
                    )
                raw_cache = get_sloppak_cache() if get_sloppak_cache else None
                cache = Path(raw_cache) if raw_cache is not None else Path(tempfile.gettempdir()) / "sloppak_cache"
                cache.mkdir(parents=True, exist_ok=True)
                loaded = sloppak_mod.load_song(filename, Path(dlc), cache)
                return _song_to_gp5(loaded.song, arrangement)

            # Any non-sloppak input is unsupported.
            return Response(
                "Only .sloppak songs are supported",
                status_code=400,
            )
        except Exception as e:
            import traceback
            traceback.print_exc()
            return Response(f"Conversion error: {e}", status_code=500)
