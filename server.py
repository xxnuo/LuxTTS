import io
import os
import uuid
import time
import tempfile
from pathlib import Path
from contextlib import asynccontextmanager

import torch
import soundfile as sf
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from zipvoice.luxvoice import LuxTTS

def _detect_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"

DEVICE = os.environ.get("LUXTTS_DEVICE", _detect_device())
THREADS = int(os.environ.get("LUXTTS_THREADS", "4"))

tts: LuxTTS | None = None
prompts: dict[str, dict] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global tts
    print(f"Loading LuxTTS model on {DEVICE}...")
    tts = LuxTTS("YatharthS/LuxTTS", device=DEVICE, threads=THREADS)
    print("Model loaded.")
    yield
    tts = None


app = FastAPI(title="LuxTTS API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SAMPLES_DIR = Path(__file__).parent / "samples"
ui_dist = Path(__file__).parent / "ui" / "dist"

if SAMPLES_DIR.is_dir():
    app.mount("/api/samples/audio", StaticFiles(directory=str(SAMPLES_DIR)), name="samples_audio")
if ui_dist.is_dir():
    app.mount("/ui", StaticFiles(directory=str(ui_dist), html=True), name="ui")


@app.get("/api/status")
async def status():
    return {
        "ready": tts is not None,
        "device": DEVICE,
        "prompts": list(prompts.keys()),
    }


@app.post("/api/prompt/upload")
async def upload_prompt(
    file: UploadFile = File(...),
    rms: float = Form(0.01),
    name: str = Form(""),
    prompt_text: str = Form(...),
):
    if tts is None:
        raise HTTPException(503, "Model not loaded")

    suffix = Path(file.filename or "audio.wav").suffix
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        content = await file.read()
        tmp.write(content)
        tmp.flush()
        tmp.close()

        print(f"[DEBUG] upload_prompt: prompt_text='{prompt_text[:80]}...', rms={rms}")
        encoded = tts.encode_prompt(tmp.name, rms=rms, prompt_text=prompt_text)
        prompt_id = uuid.uuid4().hex[:12]
        label = name.strip() or file.filename or prompt_id
        prompts[prompt_id] = {"encoded": encoded, "name": label}
        return {"id": prompt_id, "name": label}
    finally:
        os.unlink(tmp.name)


@app.delete("/api/prompt/{prompt_id}")
async def delete_prompt(prompt_id: str):
    if prompt_id not in prompts:
        raise HTTPException(404, "Prompt not found")
    del prompts[prompt_id]
    return {"ok": True}


@app.get("/api/prompts")
async def list_prompts():
    return [{"id": k, "name": v["name"]} for k, v in prompts.items()]


@app.post("/api/tts")
async def text_to_speech(
    text: str = Form(...),
    prompt_id: str = Form(...),
    num_steps: int = Form(4),
    guidance_scale: float = Form(3.0),
    t_shift: float = Form(0.5),
    speed: float = Form(1.0),
    return_smooth: bool = Form(False),
):
    if tts is None:
        raise HTTPException(503, "Model not loaded")
    if prompt_id not in prompts:
        raise HTTPException(404, "Prompt not found, upload one first")

    encoded = prompts[prompt_id]["encoded"]
    t0 = time.time()
    wav = tts.generate_speech(
        text,
        encoded,
        num_steps=num_steps,
        guidance_scale=guidance_scale,
        t_shift=t_shift,
        speed=speed,
        return_smooth=return_smooth,
    )
    elapsed = time.time() - t0
    wav_np = wav.numpy().squeeze()

    buf = io.BytesIO()
    sf.write(buf, wav_np, 48000, format="WAV")
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="audio/wav",
        headers={
            "X-Generation-Time": f"{elapsed:.3f}",
            "Content-Disposition": "attachment; filename=output.wav",
        },
    )




@app.get("/api/samples")
async def list_samples():
    if not SAMPLES_DIR.is_dir():
        return []
    exts = {".wav", ".mp3", ".flac", ".ogg"}
    items = []
    for f in sorted(SAMPLES_DIR.iterdir()):
        if f.suffix.lower() in exts and f.is_file():
            items.append({"file": f.name, "name": f.stem.replace("_", " ").title()})
    return items


@app.post("/api/prompt/sample")
async def upload_sample(
    file: str = Form(...),
    rms: float = Form(0.01),
    name: str = Form(""),
    prompt_text: str = Form(...),
):
    if tts is None:
        raise HTTPException(503, "Model not loaded")
    path = SAMPLES_DIR / file
    if not path.is_file() or not path.resolve().is_relative_to(SAMPLES_DIR.resolve()):
        raise HTTPException(404, "Sample not found")
    print(f"[DEBUG] upload_sample: file={file}, prompt_text='{prompt_text[:80]}...', rms={rms}")
    encoded = tts.encode_prompt(str(path), rms=rms, prompt_text=prompt_text)
    prompt_id = uuid.uuid4().hex[:12]
    label = name.strip() or path.stem.replace("_", " ").title()
    prompts[prompt_id] = {"encoded": encoded, "name": label}
    return {"id": prompt_id, "name": label}

