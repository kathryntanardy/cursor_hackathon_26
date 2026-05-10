import hashlib
import os
import time
import logging
from contextlib import asynccontextmanager
from typing import Literal, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI
import chromadb
from chromadb.utils import embedding_functions

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("cache-engine")

CacheStatus = Literal["EXACT_HIT", "SEMANTIC_HIT", "VERIFIED_REJECT", "MISS"]

# ── Pydantic models (mirror CONTRACTS.md section 3) ──────────────────────────

class LookupRequest(BaseModel):
    query: str

class CachedResponse(BaseModel):
    content: str
    sources: list[str]

class LookupResponse(BaseModel):
    status: CacheStatus
    similarity: Optional[float]
    cached_response: Optional[CachedResponse]
    cached_query: Optional[str]

class InsertRequest(BaseModel):
    query: str
    response: CachedResponse

class InsertResponse(BaseModel):
    ok: bool

class ResetResponse(BaseModel):
    ok: bool
    cleared_count: int

class MetricsResponse(BaseModel):
    cache_size: int
    hit_count: int
    miss_count: int
    reject_count: int


# ── CacheEngine ───────────────────────────────────────────────────────────────

class CacheEngine:
    EXACT_THRESHOLD = 0.97
    SEMANTIC_FLOOR  = 0.80

    def __init__(
        self,
        chroma_client,
        collection,
        clod_client: OpenAI,
        verifier_model: str,
    ):
        self._chroma = chroma_client
        self._col = collection
        self._clod = clod_client
        self._verifier_model = verifier_model
        self._hit_count = 0
        self._miss_count = 0
        self._reject_count = 0

    def lookup(self, query: str) -> dict:
        if self._col.count() == 0:
            self._miss_count += 1
            return {"status": "MISS", "similarity": None,
                    "cached_response": None, "cached_query": None}

        results = self._col.query(
            query_texts=[query],
            n_results=1,
            include=["documents", "metadatas", "distances"],
        )

        distance   = results["distances"][0][0]
        similarity = 1.0 - distance
        cached_query = results["documents"][0][0]
        meta         = results["metadatas"][0][0]
        sources_raw  = meta.get("sources", "")
        sources      = sources_raw.split("|||") if sources_raw else []
        cached_resp  = CachedResponse(content=meta["content"], sources=sources)

        if similarity >= self.EXACT_THRESHOLD:
            self._hit_count += 1
            return {"status": "EXACT_HIT", "similarity": similarity,
                    "cached_response": cached_resp.model_dump(),
                    "cached_query": cached_query}

        if similarity >= self.SEMANTIC_FLOOR:
            verdict = self._verify(query, cached_query, meta["content"], sources)
            if verdict:
                self._hit_count += 1
                return {"status": "SEMANTIC_HIT", "similarity": similarity,
                        "cached_response": cached_resp.model_dump(),
                        "cached_query": cached_query}
            else:
                self._reject_count += 1
                return {"status": "VERIFIED_REJECT", "similarity": similarity,
                        "cached_response": None, "cached_query": cached_query}

        self._miss_count += 1
        return {"status": "MISS", "similarity": None,
                "cached_response": None, "cached_query": None}

    def insert(self, query: str, response: dict) -> None:
        sources_str = "|||".join(response.get("sources", []))
        # Stable across process restarts (built-in hash() is randomized per interpreter).
        entry_id = hashlib.sha256(query.encode("utf-8")).hexdigest()
        self._col.upsert(
            documents=[query],
            metadatas=[{
                "content":     response["content"],
                "sources":     sources_str,
                "inserted_at": int(time.time()),
            }],
            ids=[entry_id],
        )

    def reset(self) -> int:
        cleared = self._col.count()
        self._chroma.delete_collection("nia_cache")
        ef = embedding_functions.SentenceTransformerEmbeddingFunction(
            model_name="all-MiniLM-L6-v2"
        )
        self._col = self._chroma.get_or_create_collection(
            name="nia_cache",
            embedding_function=ef,
            metadata={"hnsw:space": "cosine"},
        )
        self._hit_count = 0
        self._miss_count = 0
        self._reject_count = 0
        return cleared

    @property
    def stats(self):
        return {
            "cache_size":    self._col.count(),
            "hit_count":     self._hit_count,
            "miss_count":    self._miss_count,
            "reject_count":  self._reject_count,
        }

    def _verify(self, new_query: str, cached_query: str,
                cached_content: str, cached_sources: list[str]) -> bool:
        sources_str = ", ".join(cached_sources) if cached_sources else "none"
        prompt = (
            f'A previous query "{cached_query}" returned this codebase context:\n'
            f'---\n{cached_content[:2000]}\n---\n'
            f'Sources: {sources_str}\n\n'
            f'Would this same context correctly and completely answer the new query "{new_query}"?\n'
            f'Consider whether the relevant files, functions, and symbols overlap.\n\n'
            f'Respond with exactly one word: YES or NO.'
        )
        try:
            resp = self._clod.chat.completions.create(
                model=self._verifier_model,
                messages=[{"role": "user", "content": prompt}],
                max_completion_tokens=8,
                temperature=0,
            )
            text = (resp.choices[0].message.content or "").strip().upper()
            return "YES" in text
        except Exception as e:
            logger.error(f"CLōD verifier failed: {e}")
            return False  # fail closed — don't serve a potentially wrong cache hit


# ── App & lifespan ────────────────────────────────────────────────────────────

cache_engine: CacheEngine | None = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global cache_engine

    ef = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name="all-MiniLM-L6-v2"
    )
    db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_data")
    chroma_client = chromadb.PersistentClient(path=db_path)
    collection = chroma_client.get_or_create_collection(
        name="nia_cache",
        embedding_function=ef,
        metadata={"hnsw:space": "cosine"},
    )

    # Pre-warm so first real query has no cold-start delay
    ef(["warmup query to load tokenizer and model weights"])
    logger.info(f"ChromaDB ready at {db_path} — {collection.count()} entries loaded")

    clod_client = OpenAI(
        base_url="https://api.clod.io/v1",
        api_key=os.environ["CLOD_API_KEY"],
    )
    verifier_model = os.getenv("CLOD_VERIFIER_MODEL", "Llama 3.1 8B")
    cache_engine = CacheEngine(
        chroma_client, collection, clod_client, verifier_model=verifier_model
    )
    logger.info("Gray-zone verifier: CLōD model %r", verifier_model)
    yield


app = FastAPI(title="Nia Cache Engine", lifespan=lifespan)

# CORS must be added before routes
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/lookup", response_model=LookupResponse)
async def lookup(req: LookupRequest):
    result = cache_engine.lookup(req.query)
    return LookupResponse(**result)


@app.post("/insert", response_model=InsertResponse)
async def insert(req: InsertRequest):
    cache_engine.insert(req.query, req.response.model_dump())
    return InsertResponse(ok=True)


@app.post("/reset", response_model=ResetResponse)
async def reset():
    cleared = cache_engine.reset()
    return ResetResponse(ok=True, cleared_count=cleared)


@app.get("/metrics", response_model=MetricsResponse)
async def metrics():
    return MetricsResponse(**cache_engine.stats)
