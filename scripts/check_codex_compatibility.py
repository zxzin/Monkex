"""Read-only compatibility check for the current user's Codex; prints no task/account contents."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from twin_shell.app_server import AppServerClient


def main() -> int:
    client = AppServerClient(request_timeout_seconds=15)
    checks = {}
    try:
        client.start()
        checks["initialize"] = "ok"
        for method, params in (("thread/list", {"limit": 1}), ("account/rateLimits/read", None)):
            response = client.request(method, params)
            checks[method] = "ok" if isinstance(response.get("result"), dict) and not response.get("error") else "unavailable"
    except Exception as error:
        checks["connection"] = type(error).__name__
    finally:
        client.close()
    print(json.dumps({"platform": sys.platform, "checks": checks}, ensure_ascii=False))
    return 0 if len(checks) == 3 and all(status == "ok" for status in checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
