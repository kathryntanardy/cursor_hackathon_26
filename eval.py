#!/usr/bin/env python3
"""
eval.py — 25-query evaluation harness for the cache API at http://localhost:8000

Categories:
  8  EXACT_HIT       — seed inserted, then exact same query → score ≥ 0.97
  8  SEMANTIC_HIT    — paraphrase of a seeded query, verifier says YES
  9  VERIFIED_REJECT — near-miss with a specifier that changes intent, verifier says NO

Queries 1–3 use the demo triplet from CONTRACTS.md §4.
Exit 0 if ≥ 22/25 pass, else exit 1.
"""

import sys
import requests

BASE_URL = "http://localhost:8000"

# Per-seed content that is topic-specific so the Haiku verifier can correctly
# say YES for on-topic paraphrases (SEMANTIC_HIT) and NO for specifier-modified
# queries that change intent (VERIFIED_REJECT).
SEED_RESPONSES = {
    "How does authentication work in this codebase?": {
        "content": (
            "Authentication uses JWT tokens. The auth middleware (src/middleware/auth.py) "
            "validates Bearer tokens on every protected route. Login is handled by "
            "POST /auth/login which calls verify_password() and returns a signed JWT. "
            "The token payload includes user_id, email, and role. Tokens expire after "
            "24 hours. AuthService (src/services/auth.py) handles token generation and "
            "validation via the python-jose library."
        ),
        "sources": ["src/middleware/auth.py", "src/services/auth.py", "src/routers/auth.py"],
    },
    "What does the database layer look like?": {
        "content": (
            "The database layer uses SQLAlchemy ORM with a PostgreSQL backend. Models "
            "are in src/models/ and inherit from Base (src/database.py). "
            "DatabaseService provides get_db() as a FastAPI dependency. Connection "
            "pooling is handled automatically with pool_size=10. Migrations are managed "
            "via Alembic (alembic/versions/). Sessions use context managers to ensure "
            "connections are properly closed after each request."
        ),
        "sources": ["src/database.py", "src/models/", "alembic/versions/"],
    },
    "How are API routes defined in this project?": {
        "content": (
            "API routes are defined using FastAPI routers in src/routers/. Each module "
            "(users.py, items.py, etc.) creates an APIRouter and is registered in "
            "src/main.py via app.include_router(). Routes use Pydantic models for "
            "request/response validation. HTTP methods follow REST conventions. "
            "Route dependencies (auth, pagination) are injected via FastAPI Depends()."
        ),
        "sources": ["src/main.py", "src/routers/users.py", "src/routers/items.py"],
    },
    "What is the error handling strategy?": {
        "content": (
            "Error handling uses FastAPI exception handlers registered in src/main.py. "
            "Custom exception classes in src/exceptions.py extend HTTPException with "
            "structured responses. Unhandled exceptions return 500 with a generic "
            "message. Pydantic validation errors return 422 with field-level details. "
            "ErrorResponse (src/schemas/errors.py) standardises the JSON shape: "
            "{code, message, details}. Server errors are logged with full stack traces."
        ),
        "sources": ["src/main.py", "src/exceptions.py", "src/schemas/errors.py"],
    },
    "How does the caching mechanism work?": {
        "content": (
            "The caching layer uses ChromaDB for semantic lookup and a Python dict for "
            "exact-match caching. The CacheEngine class (src/cache.py) manages both. "
            "Cache keys are normalised query strings. TTL defaults to 3600 seconds. "
            "On MISS the result is inserted via insert(). The cache is pre-warmed at "
            "startup by embedding a dummy string to avoid cold-start latency on the "
            "first real query."
        ),
        "sources": ["src/cache.py", "src/main.py"],
    },
    "Describe the project's file structure and directory layout.": {
        "content": (
            "The project root contains: src/ (application code), tests/ (pytest suite), "
            "alembic/ (migrations), and config/ (environment settings). Inside src/: "
            "main.py (FastAPI entry point), routers/ (route handlers), services/ "
            "(business logic), models/ (ORM models), schemas/ (Pydantic models), "
            "middleware/ (auth, logging, CORS), and utils/ (shared helpers). Static "
            "assets are served from src/static/."
        ),
        "sources": ["src/", "src/main.py", "src/routers/", "src/services/"],
    },
    "How are environment variables managed in this project?": {
        "content": (
            "Environment variables are managed via python-dotenv. A .env file at the "
            "project root defines DATABASE_URL, SECRET_KEY, ANTHROPIC_API_KEY, and "
            "other config values. The config module (src/config.py) loads these with "
            "Pydantic BaseSettings for type validation and defaults. Sensitive values "
            "are never committed — .env is in .gitignore. A .env.example file "
            "documents all required variables."
        ),
        "sources": ["src/config.py", ".env.example", ".gitignore"],
    },
    "What testing framework does this project use?": {
        "content": (
            "The project uses pytest as the test runner. Tests live in tests/ organised "
            "into unit/ and fixtures/. conftest.py sets up an in-memory SQLite test "
            "database. Run the suite with: pytest tests/ -v. Coverage is measured with "
            "pytest-cov. The CI pipeline runs tests on every PR via GitHub Actions "
            "(.github/workflows/test.yml). Fixtures use factory_boy; mocks use "
            "unittest.mock.patch."
        ),
        "sources": ["tests/conftest.py", "tests/unit/", ".github/workflows/test.yml"],
    },
    "How does the logging system work in this codebase?": {
        "content": (
            "The logging system uses Python's standard logging module configured in "
            "src/logging_config.py. Log levels are DEBUG in development and INFO in "
            "production. Handlers include a StreamHandler (stdout) and an optional "
            "file handler. The middleware/logging.py adds request_id to every log "
            "line for traceability. FastAPI access logs capture method, path, status "
            "code, and latency. Log rotation is managed by logrotate in production."
        ),
        "sources": ["src/logging_config.py", "src/middleware/logging.py"],
    },
}

# Base queries inserted before the test run.
# S1–S8 are each exercised by one EXACT_HIT, one SEMANTIC_HIT, and one VERIFIED_REJECT.
# S9 provides the seed for the 9th VERIFIED_REJECT only.
SEEDS = list(SEED_RESPONSES.keys())

# fmt: off
# (query, expected_status, short_description)
TEST_CASES = [
    # ── EXACT_HIT (8) — identical to seed, similarity ≥ 0.97 ─────────────────
    ("How does authentication work in this codebase?",
     "EXACT_HIT",        "Demo triplet Q1 — exact auth query"),                   # 1

    # ── SEMANTIC_HIT (8) — paraphrase, similarity 0.80–0.97, verifier YES ─────
    ("Walk me through the auth flow in this app.",
     "SEMANTIC_HIT",     "Demo triplet Q2 — auth paraphrase"),                    # 2

    # ── VERIFIED_REJECT (9) — specifier changes intent, verifier NO ───────────
    ("How does authentication work for the admin panel specifically?",
     "VERIFIED_REJECT",  "Demo triplet Q3 — admin-panel auth (gray-zone reject)"), # 3

    # ── EXACT_HIT continued ───────────────────────────────────────────────────
    ("What does the database layer look like?",
     "EXACT_HIT",        "Exact database query"),                                  # 4
    ("How are API routes defined in this project?",
     "EXACT_HIT",        "Exact API routes query"),                                # 5
    ("What is the error handling strategy?",
     "EXACT_HIT",        "Exact error handling query"),                            # 6
    ("How does the caching mechanism work?",
     "EXACT_HIT",        "Exact caching query"),                                   # 7
    ("Describe the project's file structure and directory layout.",
     "EXACT_HIT",        "Exact file structure query"),                            # 8
    ("How are environment variables managed in this project?",
     "EXACT_HIT",        "Exact env-vars query"),                                  # 9
    ("What testing framework does this project use?",
     "EXACT_HIT",        "Exact testing-framework query"),                         # 10

    # ── SEMANTIC_HIT continued ────────────────────────────────────────────────
    ("Explain how data persistence works here.",
     "SEMANTIC_HIT",     "DB paraphrase"),                                         # 11
    ("What's the approach for defining routes in this project?",
     "SEMANTIC_HIT",     "API routes paraphrase"),                                 # 12
    ("How does this app handle exceptions and failures?",
     "SEMANTIC_HIT",     "Error handling paraphrase"),                             # 13
    ("Tell me about the in-memory cache layer in this app.",
     "SEMANTIC_HIT",     "Caching paraphrase"),                                    # 14
    ("What does the folder and file organization look like?",
     "SEMANTIC_HIT",     "File structure paraphrase"),                             # 15
    ("Where are secrets and configuration values stored in this project?",
     "SEMANTIC_HIT",     "Env-vars paraphrase"),                                   # 16
    ("How do you run the tests in this repository?",
     "SEMANTIC_HIT",     "Testing paraphrase"),                                    # 17
    # ── VERIFIED_REJECT continued ─────────────────────────────────────────────
    ("How does the logging system handle security and audit events specifically?",
     "VERIFIED_REJECT",  "Logging + security/audit specifier (vs S9)"),            # 18

    ("What does the database layer look like for write operations?",
     "VERIFIED_REJECT",  "DB + write-ops specifier"),                              # 19
    ("How are API routes defined for admin-only endpoints?",
     "VERIFIED_REJECT",  "API routes + admin specifier"),                          # 20
    ("What is the error handling strategy specifically for unit tests?",
     "VERIFIED_REJECT",  "Error handling + unit-tests specifier"),                 # 21
    ("How does the caching mechanism work for authenticated users only?",
     "VERIFIED_REJECT",  "Caching + auth-users specifier"),                        # 22
    ("Describe the project structure for the frontend modules only.",
     "VERIFIED_REJECT",  "File structure + frontend specifier"),                   # 23
    ("How are environment variables managed in production deployments?",
     "VERIFIED_REJECT",  "Env-vars + production specifier"),                       # 24
    ("What testing framework is used for end-to-end and integration tests?",
     "VERIFIED_REJECT",  "Testing + e2e/integration specifier"),                   # 25
]
# fmt: on

assert len(TEST_CASES) == 25, f"Expected 25 test cases, got {len(TEST_CASES)}"
assert sum(1 for _, s, _ in TEST_CASES if s == "EXACT_HIT") == 8
assert sum(1 for _, s, _ in TEST_CASES if s == "SEMANTIC_HIT") == 8
assert sum(1 for _, s, _ in TEST_CASES if s == "VERIFIED_REJECT") == 9


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def reset_cache() -> int:
    r = requests.post(f"{BASE_URL}/reset", timeout=10)
    r.raise_for_status()
    return r.json().get("cleared_count", 0)


def insert_seed(query: str) -> None:
    payload = {"query": query, "response": SEED_RESPONSES[query]}
    r = requests.post(f"{BASE_URL}/insert", json=payload, timeout=10)
    r.raise_for_status()


def lookup(query: str) -> dict:
    r = requests.post(f"{BASE_URL}/lookup", json={"query": query}, timeout=30)
    r.raise_for_status()
    return r.json()


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    width = 62
    print("=" * width)
    print("Cache API Eval — 25 queries")
    print(f"Target: {BASE_URL}")
    print("=" * width)

    # 1. Reset
    try:
        cleared = reset_cache()
        print(f"Cache reset OK (cleared {cleared} entries)\n")
    except Exception as e:
        print(f"ERROR: could not reach {BASE_URL}/reset — {e}")
        print("Is the FastAPI service running?")
        sys.exit(2)

    # 2. Insert seeds
    print(f"Seeding {len(SEEDS)} base queries...")
    for seed in SEEDS:
        try:
            insert_seed(seed)
        except Exception as e:
            print(f"  ERROR inserting seed {seed!r}: {e}")
            sys.exit(2)
    print("Seeds inserted.\n")

    # 3. Run test cases
    print(f"{'#':<4} {'Status':<16} {'Expected':<16} {'Sim':>6}  Description")
    print("-" * width)

    results: list[tuple[int, bool, str, str, str | None]] = []

    for i, (query, expected, desc) in enumerate(TEST_CASES, start=1):
        try:
            resp = lookup(query)
            actual = resp.get("status", "")
            sim = resp.get("similarity")
            passed = actual == expected
        except Exception as e:
            actual = f"ERROR({e})"
            sim = None
            passed = False

        results.append((i, passed, expected, actual, sim))

        mark = "PASS" if passed else "FAIL"
        sim_str = f"{sim:6.3f}" if sim is not None else "  None"
        flag = "" if passed else " ◄"
        print(f"[{mark}] Q{i:02d} {actual:<16} {expected:<16} {sim_str}  {desc}{flag}")
        if not passed and not actual.startswith("ERROR"):
            print(f"       query: {query!r}")

    # 4. Summary
    passed_count = sum(1 for _, ok, *_ in results if ok)
    total = len(results)
    threshold_met = passed_count >= 22

    print("=" * width)
    verdict = "PASS" if threshold_met else "FAIL"
    print(f"[{verdict}] {passed_count}/{total} passed  (threshold ≥ 22)")
    print()

    for cat in ("EXACT_HIT", "SEMANTIC_HIT", "VERIFIED_REJECT"):
        cat_rows = [(ok, actual) for _, ok, exp, actual, _ in results if exp == cat]
        cat_pass = sum(1 for ok, _ in cat_rows if ok)
        print(f"  {cat:<20} {cat_pass}/{len(cat_rows)}")

        failures = [(actual,) for ok, actual in cat_rows if not ok]
        for (actual,) in failures:
            print(f"    → got {actual}")

    print("=" * width)
    sys.exit(0 if threshold_met else 1)


if __name__ == "__main__":
    main()
