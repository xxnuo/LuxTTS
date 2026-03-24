import { useState, useRef, useCallback, useEffect, useMemo } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  uploadPrompt,
  deletePrompt,
  listPrompts,
  generateSpeech,
  getStatus,
  listSamples,
  uploadSample,
  type TTSParams,
} from "@/lib/api"
import {
  LocaleContext,
  useT,
  useLocale,
  detectLocale,
  SAMPLE_TEXTS,
  SAMPLE_VOICE_SCRIPTS,
  type Locale,
} from "@/lib/i18n"
import {
  Microphone,
  Play,
  Pause,
  Trash,
  UploadSimple,
  SpeakerHigh,
  Waveform,
  DownloadSimple,
  Lightning,
  GearSix,
  X,
  Sun,
  Moon,
  Translate,
  MusicNotes,
} from "@phosphor-icons/react"

interface PromptInfo {
  id: string
  name: string
  audioUrl?: string
  builtin?: boolean
}

interface SampleInfo {
  file: string
  name: string
}

interface GenerationResult {
  url: string
  time: number | null
  text: string
}

type Theme = "light" | "dark"

function detectTheme(): Theme {
  const stored = localStorage.getItem("theme")
  if (stored === "light" || stored === "dark") return stored
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

export default function App() {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)
  const [theme, setThemeState] = useState<Theme>(detectTheme)

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    localStorage.setItem("locale", l)
  }, [])

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    localStorage.setItem("theme", t)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
  }, [theme])

  const localeCtx = useMemo(
    () => ({ locale, setLocale }),
    [locale, setLocale],
  )

  return (
    <LocaleContext.Provider value={localeCtx}>
      <AppContent
        theme={theme}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
      />
    </LocaleContext.Provider>
  )
}

function AppContent({
  theme,
  onToggleTheme,
}: {
  theme: Theme
  onToggleTheme: () => void
}) {
  const t = useT()
  const { locale, setLocale } = useLocale()

  const [status, setStatus] = useState<{
    ready: boolean
    device: string
    voices: string[]
  } | null>(null)
  const [prompts, setPrompts] = useState<PromptInfo[]>([])
  const [selectedPrompt, setSelectedPrompt] = useState("")
  const [text, setText] = useState("")
  const [uploading, setUploading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [results, setResults] = useState<GenerationResult[]>([])
  const [playingIdx, setPlayingIdx] = useState<number | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState("")
  const [samples, setSamples] = useState<SampleInfo[]>([])
  const [loadingSample, setLoadingSample] = useState("")
  const [previewAudio, setPreviewAudio] = useState<string | null>(null)
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [promptText, setPromptText] = useState("")

  const [numSteps, setNumSteps] = useState(4)
  const [guidanceScale, setGuidanceScale] = useState(3.0)
  const [tShift, setTShift] = useState(0.5)
  const [speed, setSpeed] = useState(1.0)
  const [returnSmooth, setReturnSmooth] = useState(false)
  const [promptRms, setPromptRms] = useState(0.01)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioRefs = useRef<Map<number, HTMLAudioElement>>(new Map())
  const previewRef = useRef<HTMLAudioElement>(null)

  const refreshPrompts = useCallback(async () => {
    try {
      const list = await listPrompts()
      setPrompts((prev) => {
        const builtins = prev.filter((p) => p.builtin)
        const audioMap = new Map(prev.map((p) => [p.id, p.audioUrl]))
        const uploaded = list.map((p) => ({ ...p, audioUrl: audioMap.get(p.id) }))
        return [...builtins, ...uploaded]
      })
    } catch {
      /* ignore */
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getStatus()
      setStatus(s)
      if (s.voices?.length > 0) {
        setPrompts((prev) => {
          const nonBuiltin = prev.filter((p) => !p.builtin)
          const builtins: PromptInfo[] = s.voices.map((v) => ({
            id: v,
            name: v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
            audioUrl: `/api/samples/audio/${v}.wav`,
            builtin: true,
          }))
          return [...builtins, ...nonBuiltin]
        })
        setSelectedPrompt((prev) => prev || s.voices[0])
      }
    } catch {
      setStatus(null)
    }
  }, [])

  const refreshSamples = useCallback(async () => {
    try {
      const list = await listSamples()
      setSamples(list)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    refreshStatus()
    refreshPrompts()
    refreshSamples()
    const iv = setInterval(refreshStatus, 5000)
    return () => clearInterval(iv)
  }, [refreshStatus, refreshPrompts, refreshSamples])

  const handleFileUpload = async (file: File) => {
    if (!file.type.startsWith("audio/")) {
      setError(t("uploadError"))
      return
    }
    setUploading(true)
    setError("")
    try {
      const audioUrl = URL.createObjectURL(file)
      const result = await uploadPrompt(file, {
        rms: promptRms,
        name: file.name.replace(/\.[^.]+$/, ""),
        prompt_text: promptText,
      })
      setPrompts((prev) => [...prev, { ...result, audioUrl }])
      setSelectedPrompt(result.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("uploadFailed"))
    } finally {
      setUploading(false)
    }
  }

  const handleSampleSelect = async (sample: SampleInfo) => {
    const voiceName = sample.file.replace(/\.[^.]+$/, "")
    const builtin = prompts.find((p) => p.builtin && p.id === voiceName)
    const script = SAMPLE_VOICE_SCRIPTS[sample.file] || ""
    setPromptText(script)

    if (builtin) {
      setSelectedPrompt(builtin.id)
      return
    }

    setLoadingSample(sample.file)
    setError("")
    try {
      const result = await uploadSample(sample.file, {
        rms: promptRms,
        name: sample.name,
        prompt_text: script,
      })
      const audioUrl = `/api/samples/audio/${sample.file}`
      setPrompts((prev) => [...prev, { ...result, audioUrl }])
      setSelectedPrompt(result.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("uploadFailed"))
    } finally {
      setLoadingSample("")
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFileUpload(file)
  }

  const handleDeletePrompt = async (id: string) => {
    try {
      const p = prompts.find((x) => x.id === id)
      if (p?.audioUrl?.startsWith("blob:")) URL.revokeObjectURL(p.audioUrl)
      await deletePrompt(id)
      setPrompts((prev) => prev.filter((x) => x.id !== id))
      if (selectedPrompt === id) setSelectedPrompt("")
    } catch {
      /* ignore */
    }
  }

  const handleGenerate = async () => {
    if (!text.trim() || !selectedPrompt) return
    setGenerating(true)
    setError("")
    try {
      const params: TTSParams = {
        text: text.trim(),
        prompt_id: selectedPrompt,
        num_steps: numSteps,
        guidance_scale: guidanceScale,
        t_shift: tShift,
        speed,
        return_smooth: returnSmooth,
      }
      const { blob, generationTime } = await generateSpeech(params)
      const url = URL.createObjectURL(blob)
      setResults((prev) => [
        { url, time: generationTime, text: text.trim() },
        ...prev,
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : t("genFailed"))
    } finally {
      setGenerating(false)
    }
  }

  const togglePlay = (idx: number) => {
    const audio = audioRefs.current.get(idx)
    if (!audio) return
    stopPreview()
    if (playingIdx === idx) {
      audio.pause()
      setPlayingIdx(null)
    } else {
      if (playingIdx !== null) {
        audioRefs.current.get(playingIdx)?.pause()
      }
      audio.currentTime = 0
      audio.play()
      setPlayingIdx(idx)
      audio.onended = () => setPlayingIdx(null)
    }
  }

  const removeResult = (idx: number) => {
    const r = results[idx]
    if (r) URL.revokeObjectURL(r.url)
    audioRefs.current.get(idx)?.pause()
    if (playingIdx === idx) setPlayingIdx(null)
    setResults((prev) => prev.filter((_, i) => i !== idx))
  }

  const playPreview = (url: string) => {
    if (playingIdx !== null) {
      audioRefs.current.get(playingIdx)?.pause()
      setPlayingIdx(null)
    }
    if (previewAudio === url && previewPlaying) {
      stopPreview()
      return
    }
    setPreviewAudio(url)
    setPreviewPlaying(true)
    const el = previewRef.current
    if (el) {
      el.src = url
      el.currentTime = 0
      el.play()
      el.onended = () => setPreviewPlaying(false)
    }
  }

  const stopPreview = () => {
    previewRef.current?.pause()
    setPreviewPlaying(false)
  }

  const playSamplePreview = (file: string) => {
    playPreview(`/api/samples/audio/${file}`)
  }

  const playPromptPreview = (id: string) => {
    const p = prompts.find((x) => x.id === id)
    if (p?.audioUrl) playPreview(p.audioUrl)
  }

  const selectedPromptObj = prompts.find((p) => p.id === selectedPrompt)

  const ready = status?.ready ?? false

  const textCount = useMemo(() => {
    if (!text.trim()) return ""
    const isChinese = /[\u4e00-\u9fff]/.test(text)
    if (isChinese) return `${text.trim().length} ${t("chars")}`
    return `${text.trim().split(/\s+/).length} ${t("words")}`
  }, [text, t])

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <audio ref={previewRef} className="hidden" preload="auto" />

      <header className="sticky top-0 z-10 border-b bg-background/80 px-6 py-3 backdrop-blur-sm">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <div className="flex items-center gap-3">
            <Waveform className="size-5 text-primary" weight="duotone" />
            <h1 className="text-sm font-semibold tracking-tight">{t("title")}</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setLocale(locale === "en" ? "zh" : "en")}
              title={t("language")}
            >
              <Translate className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleTheme}
              title={t("theme")}
            >
              {theme === "dark" ? (
                <Sun className="size-3.5" />
              ) : (
                <Moon className="size-3.5" />
              )}
            </Button>
            <Badge
              variant={ready ? "default" : "outline"}
              className={
                ready
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : ""
              }
            >
              <span
                className={`mr-1 inline-block size-1.5 rounded-full ${ready ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"}`}
              />
              {ready ? `${t("ready")} · ${status?.device}` : t("connecting")}
            </Badge>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-6">
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Microphone className="size-4" weight="duotone" />
                  {t("voicePrompt")}
                </CardTitle>
                <CardDescription>{t("voicePromptDesc")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("promptTextLabel")}</Label>
                  <Textarea
                    placeholder={t("promptTextPlaceholder")}
                    className="min-h-16 resize-none text-xs"
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                  />
                </div>

                <button
                  type="button"
                  className={`relative flex w-full cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed p-6 transition-colors ${
                    dragOver
                      ? "border-primary bg-primary/5"
                      : "border-muted-foreground/20 hover:border-muted-foreground/40"
                  } ${uploading ? "pointer-events-none opacity-50" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragOver(true)
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? (
                    <Spinner className="size-6" />
                  ) : (
                    <UploadSimple
                      className="size-6 text-muted-foreground"
                      weight="duotone"
                    />
                  )}
                  <span className="text-xs text-muted-foreground">
                    {uploading ? t("encodingPrompt") : t("dropAudio")}
                  </span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) handleFileUpload(f)
                      e.target.value = ""
                    }}
                  />
                </button>

                {samples.length > 0 && (
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5">
                      <MusicNotes className="size-3.5" weight="duotone" />
                      {t("sampleVoices")}
                    </Label>
                    <div className="flex flex-wrap gap-2">
                      {samples.map((s) => (
                        <div key={s.file} className="flex items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              playSamplePreview(s.file)
                            }}
                            className="size-7"
                          >
                            {previewPlaying && previewAudio === `/api/samples/audio/${s.file}` ? (
                              <Pause className="size-3" weight="fill" />
                            ) : (
                              <Play className="size-3" weight="fill" />
                            )}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!!loadingSample || uploading}
                            onClick={() => handleSampleSelect(s)}
                            className="text-xs"
                          >
                            {loadingSample === s.file && (
                              <Spinner className="mr-1.5 size-3" />
                            )}
                            {s.name}
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {prompts.length > 0 && (
                  <div className="space-y-2">
                    <Label>{t("selectPrompt")}</Label>
                    <div className="flex items-center gap-2">
                      <Select
                        value={selectedPrompt}
                        onValueChange={setSelectedPrompt}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t("choosePlaceholder")} />
                        </SelectTrigger>
                        <SelectContent>
                          {prompts.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {selectedPrompt && selectedPromptObj?.audioUrl && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => playPromptPreview(selectedPrompt)}
                        >
                          {previewPlaying && previewAudio === selectedPromptObj.audioUrl ? (
                            <Pause className="size-3.5" weight="fill" />
                          ) : (
                            <Play className="size-3.5" weight="fill" />
                          )}
                        </Button>
                      )}
                      {selectedPrompt && !selectedPromptObj?.builtin && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleDeletePrompt(selectedPrompt)}
                        >
                          <Trash className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <SpeakerHigh className="size-4" weight="duotone" />
                  {t("textToSpeech")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Textarea
                  placeholder={t("textPlaceholder")}
                  className="min-h-28 resize-none"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      handleGenerate()
                    }
                  }}
                />

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">{t("sampleTexts")}</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {SAMPLE_TEXTS[locale].map((sample, i) => (
                      <button
                        key={`sample-${locale}-${i}`}
                        type="button"
                        className="rounded-sm border border-muted-foreground/15 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        onClick={() => setText(sample)}
                      >
                        {sample.length > 28 ? sample.slice(0, 28) + "..." : sample}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{textCount}</span>
                  <Button
                    onClick={handleGenerate}
                    disabled={
                      !ready || !text.trim() || !selectedPrompt || generating
                    }
                    className="gap-2"
                  >
                    {generating ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <Lightning className="size-3.5" weight="fill" />
                    )}
                    {generating ? t("generating") : t("generate")}
                  </Button>
                </div>
              </CardContent>
            </Card>

           </div>

          <div className="flex flex-col gap-6 lg:sticky lg:top-16 lg:self-start">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Waveform className="size-4" weight="duotone" />
                  {t("results")}
                  {results.length > 0 && (
                    <Badge variant="secondary" className="ml-auto">
                      {results.length}
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {results.length === 0 ? (
                  <p className="py-8 text-center text-xs text-muted-foreground">
                    {t("noResults")}
                  </p>
                ) : (
                  <div className="max-h-[50vh] space-y-2 overflow-y-auto">
                    {results.map((r, i) => (
                      <div
                        key={r.url}
                        className="group flex items-center gap-3 border p-3 transition-colors hover:bg-muted/30"
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => togglePlay(i)}
                          className="shrink-0"
                        >
                          {playingIdx === i ? (
                            <Pause className="size-4" weight="fill" />
                          ) : (
                            <Play className="size-4" weight="fill" />
                          )}
                        </Button>
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-xs leading-relaxed">{r.text}</p>
                          {r.time !== null && (
                            <span className="text-[10px] text-muted-foreground">
                              {r.time.toFixed(2)}s
                            </span>
                          )}
                        </div>
                        <a href={r.url} download="output.wav">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="opacity-0 transition-opacity group-hover:opacity-100"
                            asChild
                          >
                            <span>
                              <DownloadSimple className="size-3.5" />
                            </span>
                          </Button>
                        </a>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => removeResult(i)}
                          className="opacity-0 transition-opacity group-hover:opacity-100"
                        >
                          <X className="size-3.5" />
                        </Button>
                        <audio
                          ref={(el) => {
                            if (el) audioRefs.current.set(i, el)
                            else audioRefs.current.delete(i)
                          }}
                          src={r.url}
                          preload="auto"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <GearSix className="size-4" weight="duotone" />
                  {t("parameters")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <ParamSlider
                  label={t("steps")}
                  value={numSteps}
                  min={1}
                  max={16}
                  step={1}
                  onChange={setNumSteps}
                />
                <ParamSlider
                  label="T-Shift"
                  value={tShift}
                  min={0.1}
                  max={1.0}
                  step={0.05}
                  onChange={setTShift}
                />
                <ParamSlider
                  label={t("speed")}
                  value={speed}
                  min={0.5}
                  max={2.0}
                  step={0.05}
                  onChange={setSpeed}
                />


                <div className="flex items-center justify-between">
                  <Label htmlFor="smooth-switch" className="text-xs">
                    {t("smoothMode")}
                  </Label>
                  <Switch
                    id="smooth-switch"
                    size="sm"
                    checked={returnSmooth}
                    onCheckedChange={setReturnSmooth}
                  />
                </div>

                <button
                  type="button"
                  className="w-full text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                >
                  {showAdvanced ? t("hideAdvanced") : t("showAdvanced")}
                </button>

                {showAdvanced && (
                  <div className="space-y-5 border-t pt-4">
                    <ParamSlider
                      label={t("guidanceScale")}
                      value={guidanceScale}
                      min={1.0}
                      max={10.0}
                      step={0.5}
                      onChange={setGuidanceScale}
                    />
                    <ParamSlider
                      label={t("promptRms")}
                      value={promptRms}
                      min={0.001}
                      max={0.1}
                      step={0.001}
                      onChange={setPromptRms}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {error && (
          <div className="mt-4 border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => setError("")}
            >
              {t("dismiss")}
            </button>
          </div>
        )}
      </main>

      <footer className="border-t px-6 py-3 text-center text-[10px] text-muted-foreground">
        LuxTTS &middot; Apache-2.0 License
      </footer>
    </div>
  )
}

function ParamSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  unit = "",
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  unit?: string
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {step < 1 ? value.toFixed(step < 0.01 ? 3 : 2) : value}
          {unit}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  )
}
